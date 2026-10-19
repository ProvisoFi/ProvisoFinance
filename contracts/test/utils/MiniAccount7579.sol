// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Execution} from "../../src/SwapKeyPolicy.sol";

interface IModule {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
}

/// @notice Test-only EIP-7702 delegate with the ERC-7579 surface SwapKeyPolicy needs (Kernel v3
///         exposes the same `executeFromExecutor` / batch encoding). Only the EOA itself may
///         execute or manage modules; installed executors may run batches.
contract MiniAccount7579 {
    bytes32 internal constant BATCH_MODE = bytes32(uint256(1) << 248);

    mapping(address => bool) public isExecutor;

    error NotSelf();
    error NotExecutor();
    error UnsupportedMode();

    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    function execute(bytes32 mode, bytes calldata executionCalldata) external payable onlySelf {
        _run(mode, executionCalldata);
    }

    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory)
    {
        if (!isExecutor[msg.sender]) revert NotExecutor();
        return _run(mode, executionCalldata);
    }

    function installModule(uint256 moduleTypeId, address module, bytes calldata data) external onlySelf {
        if (moduleTypeId != 2) revert UnsupportedMode();
        isExecutor[module] = true;
        IModule(module).onInstall(data);
    }

    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata data) external onlySelf {
        if (moduleTypeId != 2) revert UnsupportedMode();
        isExecutor[module] = false;
        IModule(module).onUninstall(data);
    }

    function _run(bytes32 mode, bytes calldata executionCalldata) internal returns (bytes[] memory out) {
        if (mode != BATCH_MODE) revert UnsupportedMode();
        Execution[] memory calls = abi.decode(executionCalldata, (Execution[]));
        out = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].callData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 32), mload(ret))
                }
            }
            out[i] = ret;
        }
    }

    receive() external payable {}
}
