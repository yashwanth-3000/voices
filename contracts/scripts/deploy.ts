import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  const baseTokenURI = process.env.BASE_TOKEN_URI || "https://voices.local/metadata/";
  const creditPriceWei = process.env.CREDIT_PRICE_WEI || ethers.parseEther("0.001").toString();

  console.log(`Deploying on chain ${network.chainId.toString()} from ${deployer.address}`);

  const StyleRegistry = await ethers.getContractFactory("StyleRegistry");
  const styleRegistry = await StyleRegistry.deploy(baseTokenURI);
  await styleRegistry.waitForDeployment();

  const RoyaltyVault = await ethers.getContractFactory("RoyaltyVault");
  const royaltyVault = await RoyaltyVault.deploy(await styleRegistry.getAddress());
  await royaltyVault.waitForDeployment();

  const CreditSystem = await ethers.getContractFactory("CreditSystem");
  const creditSystem = await CreditSystem.deploy(
    await royaltyVault.getAddress(),
    await styleRegistry.getAddress(),
    creditPriceWei
  );
  await creditSystem.waitForDeployment();

  const linkTx = await styleRegistry.setRoyaltyVault(await royaltyVault.getAddress());
  await linkTx.wait();

  const deployment = {
    network: "0g-galileo",
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    contracts: {
      StyleRegistry: await styleRegistry.getAddress(),
      RoyaltyVault: await royaltyVault.getAddress(),
      CreditSystem: await creditSystem.getAddress()
    },
    constructorArgs: {
      StyleRegistry: [baseTokenURI],
      RoyaltyVault: [await styleRegistry.getAddress()],
      CreditSystem: [await royaltyVault.getAddress(), await styleRegistry.getAddress(), creditPriceWei]
    }
  };

  const deploymentDir = path.resolve(__dirname, "../deployments");
  fs.mkdirSync(deploymentDir, { recursive: true });
  fs.writeFileSync(
    path.join(deploymentDir, "0g-galileo.json"),
    `${JSON.stringify(deployment, null, 2)}\n`
  );

  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
