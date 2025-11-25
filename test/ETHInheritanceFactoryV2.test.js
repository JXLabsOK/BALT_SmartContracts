const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ETHInheritanceFactoryV2", function () {
  async function deployFactoryFixture() {
    const [deployer, other, commissionWallet] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("ETHInheritanceFactoryV2");
    const factory = await Factory.deploy(commissionWallet.address);
    await factory.waitForDeployment();

    return { factory, deployer, other, commissionWallet };
  }

  it("constructor: requiere commissionWallet válido", async function () {
    const Factory = await ethers.getContractFactory("ETHInheritanceFactoryV2");

    await expect(
      Factory.deploy(ethers.ZeroAddress)
    ).to.be.revertedWith("Invalid commission wallet");
  });

  it("createInheritanceVault: crea un vault, lo indexa y parámetros correctos", async function () {
    const { factory, deployer, commissionWallet } = await deployFactoryFixture();

    const inactivityPeriod = 60 * 60 * 24 * 30; // 30 días

    const tx = await factory
      .connect(deployer)
      .createInheritanceVault(inactivityPeriod);
    await tx.wait();

    // Leemos desde el storage en lugar de parsear logs
    const allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(1);

    const vaultAddress = allVaults[0];

    const byTestator = await factory.getVaultsByTestator(deployer.address);
    expect(byTestator.length).to.equal(1);
    expect(byTestator[0]).to.equal(vaultAddress);

    // Leemos el vault
    const vault = await ethers.getContractAt(
      "ETHInheritanceVaultV2",
      vaultAddress
    );

    expect(await vault.testator()).to.equal(deployer.address);
    expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
    expect(await vault.inactivityPeriod()).to.equal(inactivityPeriod);
    expect(await vault.inheritanceStatus()).to.equal(0); // Active
  });

  it("createInheritanceVault: revierte si inactivityPeriod = 0", async function () {
    const { factory, deployer } = await deployFactoryFixture();

    await expect(
      factory.connect(deployer).createInheritanceVault(0)
    ).to.be.revertedWith("Invalid inactivity");
  });

  it("permite múltiples vaults por testador y testadores distintos", async function () {
    const { factory, deployer, other } = await deployFactoryFixture();

    const p1 = 3600;
    const p2 = 7200;
    const p3 = 10_800;

    // 2 vaults para deployer
    await factory.connect(deployer).createInheritanceVault(p1);
    await factory.connect(deployer).createInheritanceVault(p2);

    // 1 vault para other
    await factory.connect(other).createInheritanceVault(p3);

    const all = await factory.getAllVaults();
    expect(all.length).to.equal(3);

    const byDeployer = await factory.getVaultsByTestator(deployer.address);
    expect(byDeployer.length).to.equal(2);

    const byOther = await factory.getVaultsByTestator(other.address);
    expect(byOther.length).to.equal(1);

    for (const vAddr of byDeployer) {
      const v = await ethers.getContractAt("ETHInheritanceVaultV2", vAddr);
      expect(await v.testator()).to.equal(deployer.address);
    }

    for (const vAddr of byOther) {
      const v = await ethers.getContractAt("ETHInheritanceVaultV2", vAddr);
      expect(await v.testator()).to.equal(other.address);
    }
  });
});