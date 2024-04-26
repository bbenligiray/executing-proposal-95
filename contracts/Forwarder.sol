// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract Forwarder {
    address public immutable forwardTarget;

    constructor(address forwardTarget_) {
        forwardTarget = forwardTarget_;
    }

    fallback() external payable {
        (bool success, ) = forwardTarget.call{value: address(this).balance}("");
        require(success, "Transfer unsuccessful");
    }
}
