// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IStyleRegistryForVault {
    function recordRoyalty(uint256 tokenId, uint256 amount) external;
}

contract RoyaltyVault is ReentrancyGuard {
    IStyleRegistryForVault public immutable styleRegistry;

    mapping(address => uint256) public pending;
    mapping(address => uint256) public lifetimeEarned;
    mapping(address => uint256) public lifetimeClaimed;

    event RoyaltyDeposited(address indexed creator, uint256 indexed tokenId, address indexed payer, uint256 amount);
    event RoyaltyClaimed(address indexed creator, uint256 amount);

    error ZeroAddress();
    error NoRoyalty();
    error TransferFailed();

    constructor(address styleRegistryAddress) {
        if (styleRegistryAddress == address(0)) revert ZeroAddress();
        styleRegistry = IStyleRegistryForVault(styleRegistryAddress);
    }

    function depositRoyalty(address creator, uint256 tokenId) external payable {
        if (creator == address(0)) revert ZeroAddress();
        if (msg.value == 0) revert NoRoyalty();

        pending[creator] += msg.value;
        lifetimeEarned[creator] += msg.value;
        styleRegistry.recordRoyalty(tokenId, msg.value);

        emit RoyaltyDeposited(creator, tokenId, msg.sender, msg.value);
    }

    function claim() external nonReentrant {
        uint256 amount = pending[msg.sender];
        if (amount == 0) revert NoRoyalty();

        pending[msg.sender] = 0;
        lifetimeClaimed[msg.sender] += amount;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit RoyaltyClaimed(msg.sender, amount);
    }

    receive() external payable {
        revert NoRoyalty();
    }
}
