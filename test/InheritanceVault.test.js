const { expect } = require("chai");
const hre = require("hardhat");
const ethers = hre.ethers;
const parseEther = hre.ethers.parseEther;

describe("InheritanceVault (via Factory)", function () {
  let testator, heir, other;
  let factory, vault;
  const inactivityPeriod = 60 * 60 * 24 * 30;
  let depositAmount;

  beforeEach(async () => {
    [testator, heir, other] = await ethers.getSigners();
    depositAmount = parseEther("1");

    const Factory = await ethers.getContractFactory("InheritanceFactory");
    factory = await Factory.deploy(testator.address);

    await factory.connect(testator).createInheritanceVault(inactivityPeriod);

    const vaultAddresses = await factory.getVaultsByTestator(testator.address);
    const vaultAddress = vaultAddresses[vaultAddresses.length - 1];

    const Vault = await ethers.getContractFactory("InheritanceVault");
    vault = await Vault.attach(vaultAddress);

    await vault.connect(testator).registerInheritance(heir.address, { value: depositAmount });
  });

  it("should store the correct testator and inactivity period", async () => {
    expect(await vault.testator()).to.equal(testator.address);
    expect(await vault.inactivityPeriod()).to.equal(inactivityPeriod);
  });

  it("should revert claimInheritance if called before inactivity period", async () => {
    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Testator is still active");
  });

  it("should allow claimInheritance after inactivity period", async () => {
    await ethers.provider.send("evm_increaseTime", [inactivityPeriod + 1]);
    await ethers.provider.send("evm_mine");

    await expect(vault.connect(heir).claimInheritance()).to.not.be.reverted;
  });

  it("should prevent non-heir from claiming", async () => {
    await ethers.provider.send("evm_increaseTime", [inactivityPeriod + 1]);
    await ethers.provider.send("evm_mine");

    await expect(
      vault.connect(other).claimInheritance()
    ).to.be.revertedWith("Only the heir can claim the inheritance");
  });

  it("should prevent double claim", async () => {
    await ethers.provider.send("evm_increaseTime", [inactivityPeriod + 1]);
    await ethers.provider.send("evm_mine");

    await vault.connect(heir).claimInheritance();

    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Inheritance is not active");
  });

  it("should allow the testator to cancel before inactivity", async () => {
    await expect(vault.connect(testator).cancelInheritance()).to.not.be.reverted;
  });

  it("should prevent non-testator from canceling", async () => {
    await expect(
      vault.connect(heir).cancelInheritance()
    ).to.be.revertedWith("Only testator can cancel");
  });

  it("should revert claim after cancel", async () => {
    await vault.connect(testator).cancelInheritance();

    await ethers.provider.send("evm_increaseTime", [inactivityPeriod + 1]);
    await ethers.provider.send("evm_mine");

    await expect(
      vault.connect(heir).claimInheritance()
    ).to.be.revertedWith("Inheritance is not active");
  });

  it("should emit correct event on claim", async () => {
    await ethers.provider.send("evm_increaseTime", [inactivityPeriod + 1]);
    await ethers.provider.send("evm_mine");

    await expect(vault.connect(heir).claimInheritance())
      .to.emit(vault, "InheritanceReleased")
      .withArgs(heir.address, await vault.inheritanceAmount());
  });

  it("should allow the testator to perform a check-in", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();

    const vaultAddress = receipt.logs.find(
      (log) => log.fragment.name === "VaultCreated"
    ).args.vaultAddress;

    const Vault = await hre.ethers.getContractFactory("InheritanceVault");
    const vault = await Vault.attach(vaultAddress);

    const oldLastCheckIn = (await vault.getInheritanceDetails())[2];

    await hre.network.provider.send("evm_increaseTime", [1]);
    await hre.network.provider.send("evm_mine");

    const checkInTx = await vault.connect(testator).performCheckIn();
    await checkInTx.wait();

    const newLastCheckIn = (await vault.getInheritanceDetails())[2];
    expect(newLastCheckIn).to.be.gt(oldLastCheckIn);
  });
});