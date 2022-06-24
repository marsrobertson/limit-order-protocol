// SPDX-License-Identifier: MIT

pragma solidity 0.8.15;

import "../interfaces/IPredicateHelper.sol";
import "../libraries/Callib.sol";
import "../libraries/ArgumentsDecoder.sol";
import "./NonceManager.sol";

/// @title A helper contract for executing boolean functions on arbitrary target call results
contract PredicateHelper is NonceManager, IPredicateHelper {
    using Callib for address;
    using ArgumentsDecoder for bytes;

    error ArbitraryStaticCallFailed();
    error InvalidDispatcher();

    uint256 constant private _MAGIC_SALT = 117243;
    uint256 constant private _MAGIC_PRIME = 1337;
    uint256 constant private _DISPACTHER_SELECTORS = 5;

    constructor() {
        if (
            _calculateIndex(IPredicateHelper.or.selector) != 0 ||
            _calculateIndex(IPredicateHelper.and.selector) != 1 ||
            _calculateIndex(IPredicateHelper.eq.selector) != 2 ||
            _calculateIndex(IPredicateHelper.lt.selector) != 3 ||
            _calculateIndex(IPredicateHelper.gt.selector) != 4
        ) {
            revert InvalidDispatcher();
        }
    }

    /**
     * @notice See {IPredicateHelper-or}.
     */
    function or(uint256 offsets, bytes calldata data) public view returns(bool) {
        uint256 current;
        uint256 previous;
        for (uint256 i = 0; (current = uint32(offsets >> (i << 5))) != 0; i++) {
            (bool success, uint256 res) = _selfStaticCall(data[previous:current]);
            if (success && res == 1) {
                return true;
            }
            previous = current;
        }
        return false;
    }

    /**
     * @notice See {IPredicateHelper-and}.
     */
    function and(uint256 offsets, bytes calldata data) public view returns(bool) {
        uint256 current;
        uint256 previous;
        for (uint256 i = 0; (current = uint32(offsets >> (i << 5))) != 0; i++) {
            (bool success, uint256 res) = _selfStaticCall(data[previous:current]);
            if (!success || res != 1) {
                return false;
            }
            previous = current;
        }
        return true;
    }

    /**
     * @notice See {IPredicateHelper-eq}.
     */
    function eq(uint256 value, bytes calldata data) public view returns(bool) {
        (bool success, uint256 res) = _selfStaticCall(data);
        return success && res == value;
    }

    /**
     * @notice See {IPredicateHelper-lt}.
     */
    function lt(uint256 value, bytes calldata data) public view returns(bool) {
        (bool success, uint256 res) = _selfStaticCall(data);
        return success && res < value;
    }

    /**
     * @notice See {IPredicateHelper-gt}.
     */
    function gt(uint256 value, bytes calldata data) public view returns(bool) {
        (bool success, uint256 res) = _selfStaticCall(data);
        return success && res > value;
    }

    /// @notice Checks passed time against block timestamp
    /// @return Result True if current block timestamp is lower than `time`. Otherwise, false
    function timestampBelow(uint256 time) public view returns(bool) {
        return block.timestamp < time;  // solhint-disable-line not-rely-on-time
    }

    /// @notice Performs an arbitrary call to target with data
    /// @return Result Bytes transmuted to uint256
    function arbitraryStaticCall(address target, bytes calldata data) public view returns(uint256) {
        (bool success, uint256 res) = target.staticcallForUint(data);
        if (!success) revert ArbitraryStaticCallFailed();
        return res;
    }

    function _selfStaticCall(bytes calldata data) internal view returns(bool, uint256) {
        bytes4 selector = data.decodeSelector();
        uint256 index = _calculateIndex(selector);
        uint256 arg = data.decodeUint256(4);

        if (selector == [this.or, this.and, this.eq, this.lt, this.gt][index].selector) {
            bytes calldata param = data.decodeTailCalldata(100);
            return (true, [or, and, eq, lt, gt][index](arg, param) ? 1 : 0);
        }

        // Other functions
        if (selector == this.timestampBelow.selector) {
            return (true, timestampBelow(arg) ? 1 : 0);
        }
        if (selector == this.nonceEquals.selector) {
            uint256 arg2 = data.decodeUint256(0x24);
            return (true, nonceEquals(address(uint160(arg)), arg2) ? 1 : 0);
        }
        if (selector == this.arbitraryStaticCall.selector) {
            bytes calldata param = data.decodeTailCalldata(100);
            return (true, arbitraryStaticCall(address(uint160(arg)), param));
        }

        return address(this).staticcallForUint(data);
    }

    function _calculateIndex(bytes4 selector) private pure returns(uint256 index) {
        unchecked {
            index = (((uint256(bytes32(selector)) >> 224) ^ _MAGIC_SALT) % _MAGIC_PRIME) % _DISPACTHER_SELECTORS;
        }
    }
}
