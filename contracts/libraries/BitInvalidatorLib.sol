// SPDX-License-Identifier: MIT

pragma solidity 0.8.17;

library BitInvalidatorLib {
    error InvalidatedOrder();

    struct Data {
        mapping(uint256 => uint256) _raw;
    }

    function checkSlot(Data storage self, uint256 nonce) internal view returns(uint256) {
        uint256 invalidatorSlot = nonce >> 8;
        return self._raw[invalidatorSlot];
    }

    function checkNonce(Data storage self, uint256 nonce) internal view returns(bool) {
        uint256 invalidatorSlot = nonce >> 8;
        uint256 invalidatorBit = 1 << (nonce & 0xff);
        uint256 invalidator = self._raw[invalidatorSlot];
        return invalidator & invalidatorBit == 0;
    }

    function checkAndInvalidate(Data storage self, uint256 nonce) internal {
        uint256 invalidatorSlot = nonce >> 8;
        uint256 invalidatorBit = 1 << (nonce & 0xff);
        uint256 invalidator = self._raw[invalidatorSlot];
        if (invalidator & invalidatorBit == invalidatorBit) revert InvalidatedOrder();
        self._raw[invalidatorSlot] = invalidator | invalidatorBit;
    }

    function massInvalidate(Data storage self, uint256 nonce, uint256 additionalMask) internal {
        uint256 invalidatorSlot = nonce >> 8;
        uint256 invalidatorBits = (1 << (nonce & 0xff)) | additionalMask;
        self._raw[invalidatorSlot] |= invalidatorBits;
    }
}
