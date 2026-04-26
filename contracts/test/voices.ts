import { expect } from "chai";
import { ethers } from "hardhat";

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

    await expect(
      styleRegistry.connect(creator).mintStyle(
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
      )
    )
      .to.emit(styleRegistry, "StyleMinted")
      .withArgs(1, creator.address, creditPrice, encryptedURI, metadataHash);

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

    await expect(creditSystem.connect(consumer).buyCredits(2, { value: creditPrice * 2n }))
      .to.emit(creditSystem, "CreditsPurchased")
      .withArgs(consumer.address, 2, creditPrice * 2n);

    await expect(creditSystem.connect(consumer).spendCredit(1))
      .to.emit(royaltyVault, "RoyaltyDeposited")
      .withArgs(creator.address, 1, await creditSystem.getAddress(), creditPrice);

    expect(await creditSystem.credits(consumer.address)).to.equal(1);
    expect(await royaltyVault.pending(creator.address)).to.equal(creditPrice);

    await expect(royaltyVault.connect(creator).claim()).to.changeEtherBalances(
      [royaltyVault, creator],
      [-creditPrice, creditPrice]
    );
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

    await expect(
      styleRegistry
        .connect(creator)
        .transfer(creator.address, consumer.address, 1, ethers.toUtf8Bytes("consumer-key"), ethers.toUtf8Bytes("proof"))
    )
      .to.emit(styleRegistry, "MetadataAccessUpdated")
      .withArgs(1, consumer.address, ethers.keccak256(ethers.toUtf8Bytes("consumer-key")));

    expect(await styleRegistry.ownerOf(1)).to.equal(consumer.address);
    expect(await styleRegistry.sealedKeyOf(1, consumer.address)).to.equal(ethers.hexlify(ethers.toUtf8Bytes("consumer-key")));
  });
});
