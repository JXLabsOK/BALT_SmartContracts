const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

describe("BPROInheritanceFactoryV2", function () {
  let deployer;
  let commissionWallet;
  let testator;
  let other;
  let token;
  let factory;
  let feeBps;
  let minDeposit;

  beforeEach(async function () {
    [deployer, commissionWallet, testator, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    token = await MockERC20.deploy();
    await token.waitForDeployment();

    feeBps = 80; // 0.80%
    minDeposit = ethers.parseUnits("0.00001", 18); // 0.00001000 BPRO mínimo neto

    const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");
    factory = await Factory.deploy(
      commissionWallet.address,
      await token.getAddress(),
      feeBps,
      minDeposit
    );
    await factory.waitForDeployment();
  });

  it("guarda correctamente los parámetros del constructor", async function () {
    expect(await factory.commissionWallet()).to.equal(commissionWallet.address);
    expect(await factory.token()).to.equal(await token.getAddress());
    expect(await factory.feeBps()).to.equal(feeBps);
    expect(await factory.minDeposit()).to.equal(minDeposit);
  });

  it("revierta si el commission wallet es address(0)", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const t = await MockERC20.deploy();
    await t.waitForDeployment();

    const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");

    await expect(
      Factory.deploy(
        ethers.ZeroAddress,
        await t.getAddress(),
        80,
        ethers.parseUnits("0.00001", 18)
      )
    ).to.be.revertedWith("Invalid commission wallet");
  });

  it("revierta si el token es address(0)", async function () {
    const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");

    await expect(
      Factory.deploy(
        commissionWallet.address,
        ethers.ZeroAddress,
        80,
        ethers.parseUnits("0.00001", 18)
      )
    ).to.be.revertedWith("Invalid token");
  });

  it("revierta si feeBps es >= 10000", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const t = await MockERC20.deploy();
    await t.waitForDeployment();

    const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");

    await expect(
      Factory.deploy(
        commissionWallet.address,
        await t.getAddress(),
        10_000, // 100%
        ethers.parseUnits("0.00001", 18)
      )
    ).to.be.revertedWith("fee too high");
  });

  it("revierta si el token no es contrato (_isContract)", async function () {
    const Factory = await ethers.getContractFactory("BPROInheritanceFactoryV2");

    await expect(
      Factory.deploy(
        commissionWallet.address,
        testator.address, // EOA, no contrato
        80,
        ethers.parseUnits("0.00001", 18)
      )
    ).to.be.revertedWith("Token not a contract");
  });

  it("crea un vault y lo trackea por testador y en allVaults", async function () {
    const inactivityPeriod = 30 * 24 * 60 * 60;

    await expect(
      factory.connect(testator).createInheritanceVault(inactivityPeriod)
    )
      .to.emit(factory, "VaultCreated")
      .withArgs(testator.address, anyValue);

    const vaultsByTestator = await factory.getVaultsByTestator(testator.address);
    expect(vaultsByTestator.length).to.equal(1);

    const allVaults = await factory.getAllVaults();
    expect(allVaults.length).to.equal(1);
    expect(allVaults[0]).to.equal(vaultsByTestator[0]);

    const vaultAddress = vaultsByTestator[0];
    const vault = await ethers.getContractAt("BPROInheritanceVaultV2", vaultAddress);

    expect(await vault.testator()).to.equal(testator.address);
    expect(await vault.commissionWallet()).to.equal(commissionWallet.address);
    expect(await vault.token()).to.equal(await token.getAddress());
    expect(await vault.feeBps()).to.equal(feeBps);
    expect(await vault.minDeposit()).to.equal(minDeposit);
    expect(await vault.inheritanceStatus()).to.equal(0); // Active
  });

  it("revierta createInheritanceVault con inactivityPeriod = 0", async function () {
    await expect(
      factory.connect(testator).createInheritanceVault(0)
    ).to.be.revertedWith("Invalid inactivity");
  });

  it("factoryStaticParams devuelve token, feeBps y minDeposit", async function () {
    const [tokenAddr, fee, minDep] = await factory.factoryStaticParams();
    expect(tokenAddr).to.equal(await token.getAddress());
    expect(fee).to.equal(feeBps);
    expect(minDep).to.equal(minDeposit);
  });
});