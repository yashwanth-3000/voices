import { expect } from "chai";
import { ethers } from "hardhat";
import { BaseContract, ContractTransactionReceipt } from "ethers";

describe("voices Day 1 contracts", function () {
  async function deployFixture() {
    const [deployer, creator, consumer] = await ethers.getSigners();

    const StyleRegistry = await ethers.getContractFactory("StyleRegistry");
    const styleRegistry = await StyleRegistry.deploy("https://voices.local/metadata/");

    const RoyaltyVault = await ethers.getContractFactory("RoyaltyVault");
    const royaltyVault = await RoyaltyVault.deploy(await styleRegistry.getAddress());

    const CreditSystem = await ethers.getContractFactory("CreditSystem");
    const creditPrice = ethers.parseEther("0.001");
    const creditSystem = await CreditSystem.deploy(
      await royaltyVault.getAddress(),
      await styleRegistry.getAddress(),
      creditPrice
    );

    await styleRegistry.connect(deployer).setRoyaltyVault(await royaltyVault.getAddress());

    return { deployer, creator, consumer, styleRegistry, royaltyVault, creditSystem, creditPrice };
  }

  it("mints a style iNFT and exposes royalty metadata", async function () {
    const { creator, styleRegistry, creditPrice } = await deployFixture();
    const encryptedURI = "0g://storage/root/demo";
    const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(encryptedURI));

    const mintTx = await styleRegistry.connect(creator).mintStyle(
        "",
        encryptedURI,
        "0g://kv/profile/1",
        metadataHash,
        ethers.toUtf8Bytes("sealed-key"),
        creditPrice,
        2,
        "en",
        "technical,casual",
        "eip191://attestation"
      );
    const mintEvent = findEvent(await mintTx.wait(), styleRegistry, "StyleMinted");
    expect(mintEvent.args.tokenId).to.equal(1n);
    expect(mintEvent.args.creator).to.equal(creator.address);
    expect(mintEvent.args.royaltyWei).to.equal(creditPrice);
    expect(mintEvent.args.encryptedSamplesURI).to.equal(encryptedURI);
    expect(mintEvent.args.metadataHash).to.equal(metadataHash);

    expect(await styleRegistry.ownerOf(1)).to.equal(creator.address);
    expect(await styleRegistry.creatorOf(1)).to.equal(creator.address);
    expect(await styleRegistry.royaltyOf(1)).to.equal(creditPrice);
    expect(await styleRegistry.tokenURI(1)).to.equal("https://voices.local/metadata/1");
  });

  it("spends credits and lets creators claim royalties", async function () {
    const { creator, consumer, styleRegistry, royaltyVault, creditSystem, creditPrice } = await deployFixture();

    await styleRegistry.connect(creator).mintStyle(
      "",
      "0g://storage/root/demo",
      "0g://kv/profile/1",
      ethers.id("demo-style"),
      ethers.toUtf8Bytes("sealed-key"),
      creditPrice,
      1,
      "en",
      "technical",
      "eip191://attestation"
    );

    const buyTx = await creditSystem.connect(consumer).buyCredits(2, { value: creditPrice * 2n });
    const buyEvent = findEvent(await buyTx.wait(), creditSystem, "CreditsPurchased");
    expect(buyEvent.args.buyer).to.equal(consumer.address);
    expect(buyEvent.args.credits).to.equal(2n);
    expect(buyEvent.args.paid).to.equal(creditPrice * 2n);

    const spendTx = await creditSystem.connect(consumer).spendCredit(1);
    const royaltyEvent = findEvent(await spendTx.wait(), royaltyVault, "RoyaltyDeposited");
    expect(royaltyEvent.args.creator).to.equal(creator.address);
    expect(royaltyEvent.args.tokenId).to.equal(1n);
    expect(royaltyEvent.args.payer).to.equal(await creditSystem.getAddress());
    expect(royaltyEvent.args.amount).to.equal(creditPrice);

    expect(await creditSystem.credits(consumer.address)).to.equal(1n);
    expect(await royaltyVault.pending(creator.address)).to.equal(creditPrice);

    await royaltyVault.connect(creator).claim();
    expect(await royaltyVault.pending(creator.address)).to.equal(0n);
    expect(await royaltyVault.lifetimeClaimed(creator.address)).to.equal(creditPrice);
  });

  it("supports ERC-7857-lite transfer access metadata", async function () {
    const { creator, consumer, styleRegistry, creditPrice } = await deployFixture();

    await styleRegistry.connect(creator).mintStyle(
      "",
      "0g://storage/root/demo",
      "0g://kv/profile/1",
      ethers.id("demo-style"),
      ethers.toUtf8Bytes("creator-key"),
      creditPrice,
      1,
      "en",
      "technical",
      "eip191://attestation"
    );

    const transferTx = await styleRegistry
        .connect(creator)
        .transfer(creator.address, consumer.address, 1, ethers.toUtf8Bytes("consumer-key"), ethers.toUtf8Bytes("proof"));
    const accessEvent = findEvent(await transferTx.wait(), styleRegistry, "MetadataAccessUpdated");
    expect(accessEvent.args.tokenId).to.equal(1n);
    expect(accessEvent.args.owner).to.equal(consumer.address);
    expect(accessEvent.args.sealedKeyHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes("consumer-key")));

    expect(await styleRegistry.ownerOf(1)).to.equal(consumer.address);
    expect(await styleRegistry.sealedKeyOf(1, consumer.address)).to.equal(ethers.hexlify(ethers.toUtf8Bytes("consumer-key")));
  });
});

function findEvent(receipt: ContractTransactionReceipt | null, contract: BaseContract, eventName: string) {
  if (!receipt) {
    throw new Error(`Missing receipt while looking for ${eventName}`);
  }
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`Could not find ${eventName}`);
}
