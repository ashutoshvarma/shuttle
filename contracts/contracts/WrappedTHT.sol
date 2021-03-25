// SPDX-License-Identifier: MIT
pragma solidity >=0.6.0;

import './WrappedToken.sol';

contract WrappedaTHT is WrappedToken {
    constructor() public WrappedToken("Wrapped THT Token", "THT") {}
}
