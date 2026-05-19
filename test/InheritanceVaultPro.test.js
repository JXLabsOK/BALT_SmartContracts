// test/InheritanceVaultPro.test.js
const { expect } = require("chai");
const hre = require("hardhat");
const ethers = hre.ethers;

const parseEther = hre.ethers.parseEther;

describe("InheritanceVaultPro (via FactoryPro)", function () {
  let testator, heir, other, commission, b1, b2;
  let factory, vault;
  const inactivityPeriod = 60 * 60 * 24 * 30; // 30 days
  let depositAmount;

  async function mineAndIncreaseTime(seconds) {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
  }

  async function deployFactoryAndCreateVault(_commissionWallet, _inactivityPeriod) {
    const Factory = await ethers.getContractFactory("InheritanceFactoryPro");
    const f = await Factory.deploy(_commissionWallet);
    await f.waitForDeployment();

    const expected = await f.createInheritanceVault.staticCall(_inactivityPeriod);
    const tx = await f.connect(testator).createInheritanceVault(_inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    expect(vaultAddress).to.equal(expected);

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    return { f, v: await Vault.attach(vaultAddress), vaultAddress };
  }

  beforeEach(async () => {
    [testator, heir, other, commission, b1, b2] = await ethers.getSigners();
    depositAmount = parseEther("1");

    const Factory = await ethers.getContractFactory("InheritanceFactoryPro");
    factory = await Factory.deploy(commission.address);
    await factory.waitForDeployment();

    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    vault = await Vault.attach(vaultAddress);

    await vault.connect(testator).registerInheritance(heir.address, { value: depositAmount });
  });

  it("should store the correct testator and inactivity period", async () => {
    expect(await vault.testator()).to.equal(testator.address);
    expect(await vault.inactivityPeriod()).to.equal(inactivityPeriod);
  });

  it("should revert claimInheritance if called before inactivity period", async () => {
    await expect(vault.connect(heir).claimInheritance()).to.be.revertedWith("Testator is still active");
  });

  it("should allow claimInheritance after inactivity period", async () => {
    await mineAndIncreaseTime(inactivityPeriod + 1);
    await expect(vault.connect(heir).claimInheritance()).to.not.be.reverted;
  });

  it("should prevent non-heir from claiming", async () => {
    await mineAndIncreaseTime(inactivityPeriod + 1);
    await expect(vault.connect(other).claimInheritance()).to.be.revertedWith(
      "Only the heir can claim the inheritance"
    );
  });

  it("should prevent double claim", async () => {
    await mineAndIncreaseTime(inactivityPeriod + 1);
    await vault.connect(heir).claimInheritance();
    await expect(vault.connect(heir).claimInheritance()).to.be.revertedWith("Inheritance is not active");
  });

  it("should allow the testator to cancel before inactivity", async () => {
    await expect(vault.connect(testator).cancelInheritance()).to.not.be.reverted;
  });

  it("should prevent non-testator from canceling", async () => {
    await expect(vault.connect(heir).cancelInheritance()).to.be.revertedWith("Only testator can cancel");
  });

  it("should revert claim after cancel", async () => {
    await vault.connect(testator).cancelInheritance();
    await mineAndIncreaseTime(inactivityPeriod + 1);
    await expect(vault.connect(heir).claimInheritance()).to.be.revertedWith("Inheritance is not active");
  });

  it("should emit correct event on claim (no beneficiaries)", async () => {
    await mineAndIncreaseTime(inactivityPeriod + 1);

    const totalBefore = await ethers.provider.getBalance(vault.target);

    await expect(vault.connect(heir).claimInheritance())
      .to.emit(vault, "InheritanceReleased")
      .withArgs(heir.address, totalBefore);
  });

  it("should allow the testator to perform a check-in (updates lastCheckIn)", async () => {
    const oldLast = (await vault.getInheritanceDetails())[2];

    await mineAndIncreaseTime(2);

    await vault.connect(testator).performCheckIn();
    const newLast = (await vault.getInheritanceDetails())[2];

    expect(newLast).to.be.gt(oldLast);
  });

  it("should update lastCheckIn on registerInheritance (fresh vault)", async () => {
    const { v } = await deployFactoryAndCreateVault(commission.address, inactivityPeriod);

    const detailsBefore = await v.getInheritanceDetails();
    const prevLastCheckIn = detailsBefore[2];

    await mineAndIncreaseTime(100);

    await v.connect(testator).registerInheritance(heir.address, { value: parseEther("1") });
    const detailsAfter = await v.getInheritanceDetails();

    expect(detailsAfter[2]).to.be.gt(prevLastCheckIn);
  });

  it("should update lastCheckIn on topUp (fresh vault)", async () => {
    const { v } = await deployFactoryAndCreateVault(commission.address, inactivityPeriod);

    await v.connect(testator).registerInheritance(heir.address, { value: parseEther("1") });
    const last1 = await v.lastCheckIn();

    await mineAndIncreaseTime(5);

    await v.connect(testator).topUp({ value: parseEther("0.1") });
    const last2 = await v.lastCheckIn();

    expect(last2).to.be.gt(last1);
  });

  // BΔLT-003
  it("should revert if deposit is below minimum (1000 satoshis)", async () => {
    const { v } = await deployFactoryAndCreateVault(commission.address, inactivityPeriod);

    const tinyDeposit = hre.ethers.parseUnits("0.000000009", "ether"); // 900 sats
    await expect(v.connect(testator).registerInheritance(heir.address, { value: tinyDeposit }))
      .to.be.revertedWith("Deposit too small, minimum is 1000 satoshis");
  });

  // BΔLT-006 (fix: needs fresh vault, because in beforeEach it's already registered)
  it("should revert if heir is the zero address (fresh vault)", async () => {
    const { v } = await deployFactoryAndCreateVault(commission.address, inactivityPeriod);

    await expect(v.connect(testator).registerInheritance(ethers.ZeroAddress, { value: parseEther("1") }))
      .to.be.revertedWith("Invalid heir address");
  });

  it("should revert topUp before registerInheritance", async () => {
    const { v } = await deployFactoryAndCreateVault(commission.address, inactivityPeriod);

    await expect(v.connect(testator).topUp({ value: parseEther("0.1") }))
      .to.be.revertedWith("Inheritance not registered");
  });

  it("should revert sending RBTC directly (receive)", async () => {
    await expect(
      testator.sendTransaction({ to: vault.target, value: parseEther("0.1") })
    ).to.be.revertedWith("Use registerInheritance/topUp");
  });

  // --- Beneficiaries (Pro) ---
  it("setBeneficiaries: should enforce EOA-only, no duplicates, sum=10000, and allow clearing", async () => {
    // contract address as beneficiary -> revert
    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const dummy = await Vault.deploy(testator.address, 123, commission.address);
    await dummy.waitForDeployment();

    await expect(vault.connect(testator).setBeneficiaries([dummy.target], [10000]))
      .to.be.revertedWith("Beneficiary must be EOA");

    // duplicates
    await expect(vault.connect(testator).setBeneficiaries([b1.address, b1.address], [5000, 5000]))
      .to.be.revertedWith("Duplicate beneficiary");

    // sum != 10000
    await expect(vault.connect(testator).setBeneficiaries([b1.address, b2.address], [5000, 4000]))
      .to.be.revertedWith("Bps must sum 10000");

    // ok
    await expect(vault.connect(testator).setBeneficiaries([b1.address, b2.address], [6000, 4000]))
      .to.emit(vault, "BeneficiariesSet");

    const [recips, bps] = await vault.getBeneficiaries();
    expect(recips.length).to.equal(2);
    expect(recips[0]).to.equal(b1.address);
    expect(recips[1]).to.equal(b2.address);
    expect(bps[0]).to.equal(6000);
    expect(bps[1]).to.equal(4000);

    // clear
    await expect(vault.connect(testator).setBeneficiaries([], [])).to.emit(vault, "BeneficiariesSet");
    const [recips2, bps2] = await vault.getBeneficiaries();
    expect(recips2.length).to.equal(0);
    expect(bps2.length).to.equal(0);
  });

  // --- Helpers (Pro) ---
  it("helpers: claimableAt / isClaimable should behave correctly", async () => {
    // Create short vault for a fast claimable test
    const { v } = await deployFactoryAndCreateVault(commission.address, 60);
    await v.connect(testator).registerInheritance(heir.address, { value: parseEther("1") });

    expect(await v.isClaimable()).to.equal(false);

    await mineAndIncreaseTime(61);
    expect(await v.isClaimable()).to.equal(true);
  });
});

describe("InheritanceVaultPro - Fees & Caps (standalone)", function () {
  const inactivityPeriod = 60 * 60 * 24 * 30;
  const toWei = (s) => hre.ethers.parseEther(s);

  let testator, heir, other;

  beforeEach(async () => {
    [testator, heir, other] = await ethers.getSigners();
  });

  async function newVaultWithCommission(commissionWallet) {
    const Factory = await ethers.getContractFactory("InheritanceFactoryPro");
    const f = await Factory.deploy(commissionWallet);
    await f.waitForDeployment();

    await f.connect(testator).createInheritanceVault(inactivityPeriod);
    const addrs = await f.getVaultsByTestator(testator.address);
    const vAddr = addrs[addrs.length - 1];

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    return { f, v: await Vault.attach(vAddr) };
  }

  it("fee free-tier: <= 0.01 BTC cobra 0 y bps/cap = 0", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("0.01");
    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 0, 0, 0, dep);

    expect(await v.inheritanceAmount()).to.equal(dep);
  });

  it("fee 0.8% para 0.25 BTC sin cap (fee=0.002)", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("0.25");
    const expectedFee = toWei("0.002");

    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 80, toWei("0.20"), expectedFee, dep);

    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("fee 0.8% para 5 BTC (fee=0.04), sin cap", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("5");
    const expectedFee = toWei("0.04");

    await v.connect(testator).registerInheritance(heir.address, { value: dep });
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("fee 0.7% para 25 BTC (fee=0.175), cap 0.20 no aplica", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("25");
    const expectedFee = toWei("0.175");

    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 70, toWei("0.20"), expectedFee, dep);

    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("cap 0.20 en 50 BTC: raw=0.30 (0.6%) pero fee=0.20", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("50");
    const expectedFee = toWei("0.20");

    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 60, toWei("0.20"), expectedFee, dep);

    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("cap 0.30 en 100 BTC: raw=0.60 (0.6%) pero fee=0.30", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("100");
    const expectedFee = toWei("0.30");

    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 60, toWei("0.30"), expectedFee, dep);

    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("cap 0.50 en 1000 BTC: raw=5.0 (0.5%) pero fee=0.50", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("1000");
    const expectedFee = toWei("0.50");

    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 50, toWei("0.50"), expectedFee, dep);

    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it(">1000 BTC usa cap 0.75 (p.ej., 1200 BTC → fee=0.75)", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("1200");
    const expectedFee = toWei("0.75");

    await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
      .to.emit(v, "FeeApplied")
      .withArgs(testator.address, 50, toWei("0.75"), expectedFee, dep);

    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("bps boundaries inclusivos: 5→80bps, 30→70bps, 100→60bps", async () => {
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("5");
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 80, toWei("0.20"), toWei("0.04"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("30");
      // raw=0.21 (0.7%) cap=0.20 => fee=0.20
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 70, toWei("0.20"), toWei("0.20"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("100");
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 60, toWei("0.30"), toWei("0.30"), dep);
    }
  });

  it("cap boundaries inclusivos: 50→0.20, 250→0.30, 500→0.40, 1000→0.50", async () => {
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("50");
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 60, toWei("0.20"), toWei("0.20"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("250");
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 50, toWei("0.30"), toWei("0.30"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("500");
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 50, toWei("0.40"), toWei("0.40"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("1000");
      await expect(v.connect(testator).registerInheritance(heir.address, { value: dep }))
        .to.emit(v, "FeeApplied")
        .withArgs(testator.address, 50, toWei("0.50"), toWei("0.50"), dep);
    }
  });

  it("transfiere la comisión a la commissionWallet (usando 'other' como wallet)", async () => {
    const { v } = await newVaultWithCommission(other.address);
    const dep = toWei("25"); // 0.7% => 0.175
    const expectedFee = toWei("0.175");

    const before = await ethers.provider.getBalance(other.address);
    await v.connect(testator).registerInheritance(heir.address, { value: dep });
    const after = await ethers.provider.getBalance(other.address);

    expect(after - before).to.equal(expectedFee);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });
});