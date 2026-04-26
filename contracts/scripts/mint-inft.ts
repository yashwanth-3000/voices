import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

type DeploymentFile = {
  contracts: {
    StyleRegistry: string;
  };
};

function loadStyleRegistryAddress() {
  if (process.env.STYLE_REGISTRY_ADDRESS) {
    return process.env.STYLE_REGISTRY_ADDRESS;
  }

  const deploymentPath = path.resolve(__dirname, "../deployments/0g-galileo.json");
  const raw = fs.readFileSync(deploymentPath, "utf8");
  const deployment = JSON.parse(raw) as DeploymentFile;
  return deployment.contracts.StyleRegistry;
}

async function main() {
  const [creator] = await ethers.getSigners();
  const styleRegistryAddress = loadStyleRegistryAddress();
  const styleRegistry = await ethers.getContractAt("StyleRegistry", styleRegistryAddress);

  const encryptedSamplesURI =
    process.env.DEMO_ENCRYPTED_SAMPLES_URI ||
    "0g://storage/root/0x0000000000000000000000000000000000000000000000000000000000000000";
  const profileURI = process.env.DEMO_PROFILE_URI || "0g://kv/styles/demo-profile";
  const tokenMetadataURI = process.env.DEMO_TOKEN_METADATA_URI || "";
  const royaltyWei = process.env.DEMO_ROYALTY_WEI || ethers.parseEther("0.001").toString();
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(encryptedSamplesURI));
  const sealedKey = ethers.toUtf8Bytes("demo-sealed-key-for-creator");
  const attestationURI = process.env.DEMO_ATTESTATION_URI || "eip191://demo-attestation";

  const tx = await styleRegistry.mintStyle(
    tokenMetadataURI,
    encryptedSamplesURI,
    profileURI,
    metadataHash,
    sealedKey,
    royaltyWei,
    1,
    "en",
    "technical,casual",
    attestationURI
  );
  const receipt = await tx.wait();

  const minted = receipt?.logs
    .map((log) => {
      try {
        return styleRegistry.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event) => event?.name === "StyleMinted");

  console.log(`Creator: ${creator.address}`);
  console.log(`StyleRegistry: ${styleRegistryAddress}`);
  console.log(`Mint tx: ${tx.hash}`);
  if (minted) {
    console.log(`Token ID: ${minted.args.tokenId.toString()}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
