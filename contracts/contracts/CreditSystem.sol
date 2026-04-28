// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IStyleRegistryForCredits {
    function creatorOf(uint256 tokenId) external view returns (address);
    function royaltyOf(uint256 tokenId) external view returns (uint256);
}

interface IRoyaltyVault {
    function depositRoyalty(address creator, uint256 tokenId) external payable;
}

contract CreditSystem is Ownable {
    struct AutoRefillConfig {
        uint256 maxBudget;
        uint256 spent;
        uint256 threshold;
        uint256 perRefill;
        bool enabled;
    }

    IRoyaltyVault public royaltyVault;
    IStyleRegistryForCredits public styleRegistry;
    uint256 public creditPriceWei;

    mapping(address => uint256) public credits;
    mapping(address => uint256) public lifetimeCreditsPurchased;
    mapping(address => uint256) public lifetimeCreditsSpent;
    mapping(address => AutoRefillConfig) public autoRefill;

    event CreditsPurchased(address indexed buyer, uint256 credits, uint256 paid);
    event CreditSpent(address indexed user, uint256 indexed tokenId, address indexed creator, uint256 royaltyWei);
    event AutoRefillConfigured(
        address indexed consumer,
        uint256 maxBudget,
        uint256 threshold,
        uint256 perRefill,
        uint256 newlyFunded
    );
    event AutoRefillTriggered(address indexed consumer, uint256 creditsAdded, uint256 costWei, uint256 newBalance);
    event CreditPriceUpdated(uint256 creditPriceWei);
    event ContractsUpdated(address royaltyVault, address styleRegistry);

    error ZeroAddress();
    error ZeroCredits();
    error InsufficientPayment();
    error InsufficientCredits();
    error RoyaltyExceedsBacking();
    error RefundFailed();
    error InvalidAutoRefillConfig();
    error AutoRefillFundingMismatch();
    error AutoRefillBudgetCannotDecrease();
    error AutoRefillDisabled();
    error AutoRefillThresholdNotMet();
    error AutoRefillBudgetExhausted();

    constructor(
        address royaltyVaultAddress,
        address styleRegistryAddress,
        uint256 initialCreditPriceWei
    ) Ownable(msg.sender) {
        if (royaltyVaultAddress == address(0) || styleRegistryAddress == address(0)) revert ZeroAddress();
        royaltyVault = IRoyaltyVault(royaltyVaultAddress);
        styleRegistry = IStyleRegistryForCredits(styleRegistryAddress);
        creditPriceWei = initialCreditPriceWei;
    }

    function buyCredits(uint256 amount) external payable {
        if (amount == 0) revert ZeroCredits();

        uint256 cost = amount * creditPriceWei;
        if (msg.value < cost) revert InsufficientPayment();

        credits[msg.sender] += amount;
        lifetimeCreditsPurchased[msg.sender] += amount;

        uint256 refund = msg.value - cost;
        if (refund > 0) {
            (bool ok, ) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert RefundFailed();
        }

        emit CreditsPurchased(msg.sender, amount, cost);
    }

    function setAutoRefill(uint256 maxBudget, uint256 threshold, uint256 perRefill) external payable {
        if (maxBudget == 0 || perRefill == 0) revert InvalidAutoRefillConfig();

        AutoRefillConfig storage config = autoRefill[msg.sender];
        if (maxBudget < config.maxBudget) revert AutoRefillBudgetCannotDecrease();
        if (maxBudget != config.maxBudget + msg.value) revert AutoRefillFundingMismatch();
        if (maxBudget < config.spent + (perRefill * creditPriceWei)) revert InvalidAutoRefillConfig();

        config.maxBudget = maxBudget;
        config.threshold = threshold;
        config.perRefill = perRefill;
        config.enabled = true;

        emit AutoRefillConfigured(msg.sender, maxBudget, threshold, perRefill, msg.value);
    }

    function disableAutoRefill() external {
        autoRefill[msg.sender].enabled = false;
        emit AutoRefillConfigured(
            msg.sender,
            autoRefill[msg.sender].maxBudget,
            autoRefill[msg.sender].threshold,
            autoRefill[msg.sender].perRefill,
            0
        );
    }

    function refillFromAllowance(address consumer) external {
        AutoRefillConfig storage config = autoRefill[consumer];
        if (!config.enabled) revert AutoRefillDisabled();
        if (credits[consumer] > config.threshold) revert AutoRefillThresholdNotMet();

        uint256 cost = config.perRefill * creditPriceWei;
        if (config.spent + cost > config.maxBudget) revert AutoRefillBudgetExhausted();

        config.spent += cost;
        credits[consumer] += config.perRefill;
        lifetimeCreditsPurchased[consumer] += config.perRefill;

        emit CreditsPurchased(consumer, config.perRefill, cost);
        emit AutoRefillTriggered(consumer, config.perRefill, cost, credits[consumer]);
    }

    function spendCredit(uint256 tokenId) external {
        if (credits[msg.sender] == 0) revert InsufficientCredits();

        address creator = styleRegistry.creatorOf(tokenId);
        uint256 royaltyWei = styleRegistry.royaltyOf(tokenId);
        if (royaltyWei > address(this).balance) revert RoyaltyExceedsBacking();

        credits[msg.sender] -= 1;
        lifetimeCreditsSpent[msg.sender] += 1;

        if (royaltyWei > 0) {
            royaltyVault.depositRoyalty{value: royaltyWei}(creator, tokenId);
        }

        emit CreditSpent(msg.sender, tokenId, creator, royaltyWei);
    }

    function setCreditPrice(uint256 newCreditPriceWei) external onlyOwner {
        creditPriceWei = newCreditPriceWei;
        emit CreditPriceUpdated(newCreditPriceWei);
    }

    function setContracts(address royaltyVaultAddress, address styleRegistryAddress) external onlyOwner {
        if (royaltyVaultAddress == address(0) || styleRegistryAddress == address(0)) revert ZeroAddress();
        royaltyVault = IRoyaltyVault(royaltyVaultAddress);
        styleRegistry = IStyleRegistryForCredits(styleRegistryAddress);
        emit ContractsUpdated(royaltyVaultAddress, styleRegistryAddress);
    }
}
