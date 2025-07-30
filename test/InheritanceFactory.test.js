const { expect } = require("chai");
const hre = require("hardhat");

const isAddress = hre.ethers.isAddress;
const parseEther = hre.ethers.parseEther;

describe("InheritanceFactory", function () {
  let testator, other;
  let factory;
  const inactivityPeriod = 60 * 60 * 24 * 30;

  beforeEach(async () => {
    [testator, other] = await hre.ethers.getSigners();
    const Factory = await hre.ethers.getContractFactory("InheritanceFactory");
    factory = await Factory.connect(testator).deploy(testator.address);
    await factory.waitForDeployment();
  });

  it("should create a new Vault and emit VaultCreated", async function () {
    const tx = await factory
      .connect(testator)
      .createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();

    const vaultCreatedEvent = receipt.logs.find(
      (log) => log.fragment.name === "VaultCreated"
    );
    expect(vaultCreatedEvent).to.exist;

    const vaultAddress = vaultCreatedEvent.args.vaultAddress;
    expect(isAddress(vaultAddress)).to.be.true;
  });

  it("should fail if sent with zero value", async function () {
    const tx = await factory
      .connect(testator)
      .createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find(
      (log) => log.fragment.name === "VaultCreated"
    ).args.vaultAddress;

    const Vault = await hre.ethers.getContractFactory("InheritanceVault");
    const vault = await Vault.attach(vaultAddress);

    await expect(
      vault
        .connect(testator)
        .registerInheritance(other.address, { value: 0 })
    ).to.be.revertedWith("Must deposit funds for inheritance");
  });

  it("should create unique Vault addresses", async function () {
    const tx1 = await factory
      .connect(testator)
      .createInheritanceVault(inactivityPeriod);
    const tx2 = await factory
      .connect(testator)
      .createInheritanceVault(inactivityPeriod);

    const receipt1 = await tx1.wait();
    const receipt2 = await tx2.wait();

    const address1 = receipt1.logs.find(
      (log) => log.fragment.name === "VaultCreated"
    ).args.vaultAddress;
    const address2 = receipt2.logs.find(
      (log) => log.fragment.name === "VaultCreated"
    ).args.vaultAddress;

    expect(address1).to.not.equal(address2);
  });
  
it("should return the address of the newly created Vault", async function () {
  const expectedAddress = await hre.ethers.provider.call({
    to: factory.target, // o factory.address si estás en versión <6
    data: factory.interface.encodeFunctionData("createInheritanceVault", [inactivityPeriod])
  }).then((result) =>
    factory.interface.decodeFunctionResult("createInheritanceVault", result)[0]
  );

  const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
  const receipt = await tx.wait();

  const actualAddress = receipt.logs.find(
    (log) => log.fragment.name === "VaultCreated"
  ).args.vaultAddress;

  expect(actualAddress).to.equal(expectedAddress);
});

it("should return vaults by testator", async function () {
  const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
  const receipt = await tx.wait();

  const vaultFromEvent = receipt.logs.find(
    (log) => log.fragment.name === "VaultCreated"
  ).args.vaultAddress;

  // ✅ La llamada la hace un tercero
  const vaults = await factory.connect(other).getVaultsByTestator(testator.address);
  expect(vaults.length).to.equal(1);
  expect(vaults[0]).to.equal(vaultFromEvent);
});

it("should include the new vault in vaultsByTestator mapping", async function () {
  const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
  const receipt = await tx.wait();

  const createdVaultAddress = receipt.logs.find(
    (log) => log.fragment.name === "VaultCreated"
  ).args.vaultAddress;

  // Accedemos directamente desde el testator al mapping (no como view)
  const vaults = await factory.getVaultsByTestator(testator.address);

  expect(vaults).to.include(createdVaultAddress);
});

it("should return all created vaults", async function () {
  const tx1 = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
  await tx1.wait();

  const tx2 = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
  await tx2.wait();

  const allVaults = await factory.getAllVaults();
  expect(allVaults.length).to.equal(2);
  allVaults.forEach(addr => {
    expect(isAddress(addr)).to.be.true;
  });
});

//BΔLT-005
it("should revert if deployed with a zero commission wallet address", async function () {
  const Factory = await ethers.getContractFactory("InheritanceFactory");
  await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid commission wallet");
});
//BΔLT-005 END

});