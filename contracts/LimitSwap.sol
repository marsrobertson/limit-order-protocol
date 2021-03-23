// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/Counters.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/draft-ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

import "./utils/BytesParser.sol";
import "./EIP1271.sol";
import "./SelectorFromToAmountParser.sol";


interface InteractiveTaker {
    function interact(
        address makerAsset,
        address takerAsset,
        uint256 makingAmount,
        uint256 expectedTakingAmount
    ) external;
}


contract PredicateHelper {
    using Address for address;

    function or(address[] calldata targets, bytes[] calldata data) external view returns(bool) {
        for (uint i = 0; i < targets.length; i++) {
            bytes memory result = targets[i].functionStaticCall(data[i]);
            require(result.length != 32, "PredicateHelper: invalid call result");
            if (abi.decode(result, (bool))) {
                return true;
            }
        }
        return false;
    }

    function and(address[] calldata targets, bytes[] calldata data) external view returns(bool) {
        for (uint i = 0; i < targets.length; i++) {
            bytes memory result = targets[i].functionStaticCall(data[i]);
            require(result.length != 32, "PredicateHelper: invalid call result");
            if (!abi.decode(result, (bool))) {
                return false;
            }
        }
        return true;
    }

    function timestampBelow(uint256 time) external view returns(bool) {
        return block.timestamp < time;
    }
}


contract AmountCalculator {
    // Floor maker amount
    function getMakerAmount(uint256 orderMakerAmount, uint256 orderTakerAmount, uint256 swapTakerAmount) external pure returns(uint256) {
        return swapTakerAmount * orderMakerAmount / orderTakerAmount;
    }

    // Ceil taker amount
    function getTakerAmount(uint256 orderMakerAmount, uint256 orderTakerAmount, uint256 swapMakerAmount) external pure returns(uint256) {
        return (swapMakerAmount * orderMakerAmount + orderTakerAmount - 1) / orderTakerAmount;
    }

    function getMakerAmountNoPartialFill(uint256 orderMakerAmount, uint256 orderTakerAmount, uint256 swapTakerAmount) external pure returns(uint256) {
        return (swapTakerAmount == orderTakerAmount) ? orderMakerAmount : 0;
    }

    function getTakerAmountNoPartialFill(uint256 orderMakerAmount, uint256 orderTakerAmount, uint256 swapMakerAmount) external pure returns(uint256) {
        return (swapMakerAmount == orderMakerAmount) ? orderTakerAmount : 0;
    }
}


contract NonceManager {
    using Counters for Counters.Counter;

    mapping(address => Counters.Counter) public nonces;

    function advanceNonce() external {
        nonces[msg.sender].increment();
    }

    function nonceEquals(address makerAddress, uint256 makerNonce) external view returns(bool) {
        return nonces[makerAddress].current() == makerNonce;
    }
}


contract ImmutableOwner {
    address private immutable immutableOwner;

    modifier onlyImmutableOwner {
        require(msg.sender == immutableOwner, "ImmutableOwner: Access denied");
        _;
    }

    constructor(address _immutableOwner) {
        immutableOwner = _immutableOwner;
    }
}


abstract contract ERC20Proxy is ImmutableOwner {
    using SafeERC20 for IERC20;

    // func_0000jYAHF(address,address,uint256,address) = transferFrom + 1 = 0x8d076e86
    function func_0000jYAHF(address from, address to, uint256 amount, IERC20 token) external onlyImmutableOwner {
        token.safeTransferFrom(from, to, amount);
    }
}


abstract contract ERC721Proxy is ImmutableOwner {
    // func_4002L9TKH(address,address,uint256,address) = transferFrom + 2 = 0x8d076e87
    function func_4002L9TKH(address from, address to, uint256 tokenId, IERC721 token) external onlyImmutableOwner {
        token.transferFrom(from, to, tokenId);
    }

    // func_2000nVqcj(address,address,uint256,address) == transferFrom + 3 = 0x8d076e88
    function func_2000nVqcj(address from, address to, uint256 tokenId, IERC721 token) external onlyImmutableOwner {
        token.safeTransferFrom(from, to, tokenId);
    }
}


abstract contract ERC1155Proxy is ImmutableOwner {
    // func_7000ksXmS(address,address,uint256,address,uint256) == transferFrom + 4 = 0x8d076e89
    function func_7000ksXmS(address from, address to, uint256 amount, IERC1155 token, uint256 tokenId) external onlyImmutableOwner {
        token.safeTransferFrom(from, to, tokenId, amount, "");
    }
}


contract LimitSwap is
    EIP712("1inch Limit Order Protocol", "1"),
    PredicateHelper,
    AmountCalculator,
    NonceManager,
    ImmutableOwner(address(this)),
    ERC20Proxy,
    ERC721Proxy,
    ERC1155Proxy
{
    using Address for address;
    using SafeMath for uint256;
    using SafeERC20 for IERC20;
    using BytesParser for bytes;
    using SelectorFromToAmountParser for bytes;

    // Partial Fill:
    //   getMakerAmount := GetMakerAmountHelper.disablePartialFill(makerAmount, ...)
    //
    // Expiration Mask:
    //   predicate := PredicateHelper.timestampBelow(deadline)
    //
    // Maker Nonce:
    //   predicate := this.nonceEquals(makerAddress, makerNonce)

    event OrderFilled(
        bytes32 indexed orderHash,
        address indexed makerAddress,
        uint256 remaining
    );

    struct Order {
        address makerAsset;
        address takerAsset;
        bytes makerAssetData; // (transferFrom.selector, signer, ______, makerAmount, ...)
        bytes takerAssetData; // (transferFrom.selector, sender, signer, takerAmount, ...)
        bytes getMakerAmount; // (address, abi.encodePacked(bytes, swapTakerAmount)) => (swapMakerAmount)
        bytes getTakerAmount; // (address, abi.encodePacked(bytes, swapMakerAmount)) => (swapTakerAmount)
        bytes predicate;      // (adress, bytes) => (bool)
        bytes permitData;     // On first fill: permitData.1.call(abi.encodePacked(permit.selector, permitData.2))
    }

    bytes32 constant public LIMIT_SWAP_ORDER_TYPEHASH = keccak256(
        "Order(address makerAsset,address takerAsset,bytes makerAssetData,bytes takerAssetData,bytes getMakerAmount,bytes getTakerAmount,bytes predicate,bytes permitData)"
    );

    mapping(bytes32 => uint256) private _remaining;

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns(bytes32) {
        return _domainSeparatorV4();
    }

    function remaining(bytes32 orderHash) external view returns(uint256) {
        return _remaining[orderHash].sub(1, "LimitSwap: Unknown order");
    }

    function remainingRaw(bytes32 orderHash) external view returns(uint256) {
        return _remaining[orderHash];
    }

    function remainingsRaw(bytes32[] memory orderHashes) external view returns(uint256[] memory results) {
        results = new uint256[](orderHashes.length);
        for (uint i = 0; i < orderHashes.length; i++) {
            results[i] = _remaining[orderHashes[i]];
        }
    }

    function checkPredicate(Order memory order) public view returns(bool) {
        (address target, bytes memory data) = abi.decode(order.predicate, (address,bytes));
        bytes memory result = target.functionStaticCall(data);
        require(result.length == 32, "LimitSwap: invalid predicate return");
        return abi.decode(result, (bool));
    }

    function simulateTransferFroms(IERC20[] calldata tokens, bytes[] calldata data) external {
        bytes memory reason = new bytes(tokens.length);
        for (uint i = 0; i < tokens.length; i++) {
            (bool success, bytes memory result) = address(tokens[i]).call(data[i]);
            if (success && result.length > 0) {
                success = abi.decode(result, (bool));
            }
            reason[i] = bytes(success ? "1" : "0")[0];
        }

        // Always revert and provide per call results
        revert(string(abi.encodePacked("TRANSFERS_SUCCESSFUL_", reason)));
    }

    function cancelOrder(Order memory order) external {
        require(order.makerAssetData.getArgumentFrom() == msg.sender, "LimitSwap: Access denied");

        bytes32 orderHash = _hash(order);
        _remaining[orderHash] = 1;
        _updateOrder(orderHash, msg.sender, 0);
    }

    function fillOrder(
        Order calldata order,
        bytes memory signature,
        uint256 takingAmount,
        uint256 makingAmount,
        bool interactive,
        bytes memory permitTakerAsset
    ) external {
        bytes32 orderHash = _hash(order);
        (bool orderExists, uint256 remainingMakerAmount) = _remaining[orderHash].trySub(1);
        if (!orderExists) {
            // First fill: validate order and permit maker asset
            _validate(order, signature, orderHash);
            remainingMakerAmount = order.makerAssetData.getArgumentAmount();
            if (order.permitData.length > 0) {
                (address token, bytes memory permitData) = abi.decode(order.permitData, (address, bytes));
                token.functionCall(abi.encodePacked(IERC20Permit.permit.selector, permitData), "LimitSwap: permit failed");
            }
        }

        // Check is order is valid
        require(checkPredicate(order), "LimitSwap: prediate returned false");

        // Compute maker and taket assets amount
        if (makingAmount >> 255 == 1) {
            makingAmount = remainingMakerAmount;
        }
        if (takingAmount == 0) {
            takingAmount = (makingAmount == order.makerAssetData.getArgumentAmount())
                ? order.takerAssetData.getArgumentAmount()
                : _callGetTakerAmount(order, makingAmount);
        }
        else if (makingAmount == 0) {
            makingAmount = (takingAmount == order.takerAssetData.getArgumentAmount())
                ? order.makerAssetData.getArgumentAmount()
                : _callGetMakerAmount(order, takingAmount);
        }
        else {
            revert("LimitSwap: takingAmount or makingAmount should be 0");
        }

        require(makingAmount > 0 || takingAmount > 0, "LimitSwap: can't swap 0 amount");

        // Update remaining amount in storage
        remainingMakerAmount = remainingMakerAmount.sub(makingAmount, "LimitSwap: taking > remaining");
        _remaining[orderHash] = remainingMakerAmount + 1;
        _updateOrder(orderHash, msg.sender, remainingMakerAmount);

        // Maker => Taker
        _callMakerAssetTransferFrom(order, msg.sender, takingAmount);

        // Taker can handle funds interactively
        if (interactive) {
            InteractiveTaker(msg.sender).interact(order.makerAsset, order.takerAsset, makingAmount, takingAmount);
        }

        // Taker => Maker
        _callTakerAssetTransferFrom(order, msg.sender, takingAmount, permitTakerAsset);
    }

    function _hash(Order memory order) internal view returns(bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encodePacked(
                    LIMIT_SWAP_ORDER_TYPEHASH,
                    order.makerAsset,
                    order.takerAsset,
                    keccak256(order.makerAssetData),
                    keccak256(order.takerAssetData),
                    keccak256(order.getMakerAmount),
                    keccak256(order.getTakerAmount),
                    keccak256(order.predicate),
                    keccak256(order.permitData)
                )
            )
        );
    }

    function _validate(Order memory order, bytes memory signature, bytes32 orderHash) internal view {
        address maker = address(order.makerAssetData.getArgumentFrom());
        bytes4 makerSelector = order.makerAssetData.getArgumentSelector();
        bytes4 takerSelector = order.takerAssetData.getArgumentSelector();
        require(makerSelector >= IERC20.transferFrom.selector && makerSelector <= bytes4(uint32(IERC20.transferFrom.selector) + 10), "LimitSwap: Invalid makerAssetData.selector");
        require(takerSelector >= IERC20.transferFrom.selector && takerSelector <= bytes4(uint32(IERC20.transferFrom.selector) + 10), "LimitSwap: Invalid takerAssetData.selector");

        // bytes32 ethSignedMessageHash = ECDSA.toEthSignedMessageHash(orderHash);
        if (Address.isContract(maker)) {
            require(IEIP1271(maker).isValidSignature(orderHash, signature) == EIP1271Constants.MAGIC_VALUE, "LimitSwap: Invalid SC signature");
        }
        else {
            require(ECDSA.recover(orderHash, signature) == maker, "LimitSwap: Invalid EOA signature");
        }
    }

    function _callMakerAssetTransferFrom(Order memory order, address taker, uint256 takerAmount) internal {
        // Patch receiver or validate private order
        address takerAddress = order.makerAssetData.getArgumentTo();
        if (takerAddress == address(0)) {
            order.makerAssetData.patchBytes32(4 + 32, bytes32(uint256(uint160(taker))));
        } else {
            require(takerAddress == taker, "LimitSwap: private order");
        }

        // Patch amount
        uint256 makingAmount = _callGetMakerAmount(order, takerAmount);
        order.makerAssetData.patchBytes32(4 + 32 + 32, bytes32(makingAmount));

        // Transfer asset from maker to taker
        bytes memory result = address(order.makerAsset).functionCall(order.makerAssetData, "LimitSwap: makerAsset.call() failed");
        if (result.length > 0) {
            require(abi.decode(result, (bool)), "LimitSwap: makerAsset.call() wrong result");
        }
    }

    function _callTakerAssetTransferFrom(Order memory order, address taker, uint256 takingAmount, bytes memory permitTakerAsset) internal {
        // Patch spender
        order.takerAssetData.patchBytes32(4, bytes32(uint256(uint160(taker))));

        // Patch amount
        order.takerAssetData.patchBytes32(4 + 32 + 32, bytes32(takingAmount));

        // Taker asset permit
        if (permitTakerAsset.length > 0) {
            order.takerAsset.functionCall(abi.encodePacked(IERC20Permit.permit.selector, permitTakerAsset), "LimitSwap: permit failed");
        }

        // Transfer asset from taker to maker
        bytes memory result = address(order.takerAsset).functionCall(order.takerAssetData, "LimitSwap: takerAsset.call() failed");
        if (result.length > 0) {
            require(abi.decode(result, (bool)), "LimitSwap: takerAsset.call() wrong result");
        }
    }

    function _callGetMakerAmount(Order memory order, uint256 takerAmount) internal view returns(uint256 makerAmount) {
        (address target, bytes memory data) = abi.decode(order.getMakerAmount, (address, bytes));
        bytes memory result = target.functionStaticCall(abi.encodePacked(data, takerAmount), "LimitSwap: getMakerAmount call failed");
        return abi.decode(result, (uint256));
    }

    function _callGetTakerAmount(Order memory order, uint256 makerAmount) internal view returns(uint256 takerAmount) {
        (address target, bytes memory data) = abi.decode(order.getTakerAmount, (address, bytes));
        bytes memory result = target.functionStaticCall(abi.encodePacked(data, makerAmount), "LimitSwap: getTakerAmount call failed");
        return abi.decode(result, (uint256));
    }

    function _updateOrder(bytes32 orderHash, address maker, uint256 remainingAmount) internal {
        emit OrderFilled(orderHash, maker, remainingAmount);
    }
}
