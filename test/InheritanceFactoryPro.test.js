// test/InheritanceFactoryPro.test.js
const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;
const isAddress = ethers.isAddress;
const parseEther = ethers.parseEther;

describe("InheritanceFactoryPro + InheritanceVaultPro", function () {
  let testator, heir, b1, b2, commission, other;
  let factory;

  // Usá un periodo chico para tests
  const inactivityPeriod = 60 * 60 * 24 * 30; // 30 días
  const shortInactivity = 60; // 60s para tests de claim rápido

  // ------- Fee helpers (mismo schedule que el contrato) -------
  const ONE_BTC_WEI = 10n ** 18n;
  const FREE_TIER_MAX_WEI = 10n ** 16n; // 0.01
  const BPS_DENOM = 10000n;

  function feeBps(amountWei) {
    if (amountWei <= 5n * ONE_BTC_WEI) return 80n;
    if (amountWei <= 30n * ONE_BTC_WEI) return 70n;
    if (amountWei <= 100n * ONE_BTC_WEI) return 60n;
    return 50n;
  }

  function capWei(amountWei) {
    if (amountWei <= 50n * ONE_BTC_WEI) return 200000000000000000n; // 0.20
    if (amountWei <= 250n * ONE_BTC_WEI) return 300000000000000000n; // 0.30
    if (amountWei <= 500n * ONE_BTC_WEI) return 400000000000000000n; // 0.40
    if (amountWei <= 1000n * ONE_BTC_WEI) return 500000000000000000n; // 0.50
    return 750000000000000000n; // 0.75
  }

  function computeUpfrontFee(amountWei) {
    if (amountWei <= FREE_TIER_MAX_WEI) {
      return { fee: 0n, bps: 0n, cap: 0n };
    }
    const bps = feeBps(amountWei);
    const raw = (amountWei * bps) / BPS_DENOM;
    const cap = capWei(amountWei);
    const fee = raw > cap ? cap : raw;
    return { fee, bps, cap };
  }

  async function mineAndIncreaseTime(seconds) {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
  }

  beforeEach(async () => {
    [testator, heir, b1, b2, commission, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("InheritanceFactoryPro");
    factory = await Factory.connect(testator).deploy(commission.address);
    await factory.waitForDeployment();
  });

  // ---------------- Factory tests ----------------

  it("should create a new VaultPro and emit VaultCreated", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    await expect(tx).to.emit(factory, "VaultCreated");

    const receipt = await tx.wait();
    const ev = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated");
    expect(ev).to.exist;

    const vaultAddress = ev.args.vaultAddress;
    expect(isAddress(vaultAddress)).to.equal(true);
  });

  it("should return the address of the newly created Vault (matches staticCall)", async function () {
    const expected = await factory.connect(testator).createInheritanceVault.staticCall(inactivityPeriod);

    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const actual = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    expect(actual).to.equal(expected);
  });

  it("should create unique Vault addresses", async function () {
    const tx1 = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const tx2 = await factory.connect(testator).createInheritanceVault(inactivityPeriod);

    const r1 = await tx1.wait();
    const r2 = await tx2.wait();

    const a1 = r1.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;
    const a2 = r2.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    expect(a1).to.not.equal(a2);
  });

  it("should return vaults by testator", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultFromEvent = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const vaults = await factory.connect(other).getVaultsByTestator(testator.address);
    expect(vaults.length).to.equal(1);
    expect(vaults[0]).to.equal(vaultFromEvent);
  });

  it("should return all created vaults", async function () {
    await (await factory.connect(testator).createInheritanceVault(inactivityPeriod)).wait();
    await (await factory.connect(testator).createInheritanceVault(inactivityPeriod)).wait();

    const all = await factory.getAllVaults();
    expect(all.length).to.equal(2);
    all.forEach((addr) => expect(isAddress(addr)).to.equal(true));
  });

  it("should expose paginated getters (counts + slices)", async function () {
    // Create 3 vaults
    const v1 = await factory.connect(testator).createInheritanceVault.staticCall(inactivityPeriod);
    await (await factory.connect(testator).createInheritanceVault(inactivityPeriod)).wait();

    const v2 = await factory.connect(testator).createInheritanceVault.staticCall(inactivityPeriod);
    await (await factory.connect(testator).createInheritanceVault(inactivityPeriod)).wait();

    const v3 = await factory.connect(testator).createInheritanceVault.staticCall(inactivityPeriod);
    await (await factory.connect(testator).createInheritanceVault(inactivityPeriod)).wait();

    expect(await factory.allVaultsCount()).to.equal(3);
    expect(await factory.vaultsByTestatorCount(testator.address)).to.equal(3);

    const slice1 = await factory.getAllVaultsSlice(0, 2);
    expect(slice1.length).to.equal(2);

    const slice2 = await factory.getAllVaultsSlice(2, 10);
    expect(slice2.length).to.equal(1);

    const empty = await factory.getAllVaultsSlice(100, 10);
    expect(empty.length).to.equal(0);

    const byTestatorSlice = await factory.getVaultsByTestatorSlice(testator.address, 0, 10);
    expect(byTestatorSlice.length).to.equal(3);
    expect(byTestatorSlice[0]).to.equal(v1);
    expect(byTestatorSlice[1]).to.equal(v2);
    expect(byTestatorSlice[2]).to.equal(v3);
  });

  it("should revert if deployed with zero commission wallet address", async function () {
    const Factory = await ethers.getContractFactory("InheritanceFactoryPro");
    await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid commission wallet");
  });

  // ---------------- VaultPro integration tests ----------------

  it("VaultPro: registerInheritance should revert if value=0", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    await expect(vault.connect(testator).registerInheritance(heir.address, { value: 0n }))
      .to.be.revertedWith("Must deposit funds for inheritance");
  });

  it("VaultPro: registerInheritance applies correct fee and sets state", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    const deposit = parseEther("1"); // 1 BTC
    const { fee, bps, cap } = computeUpfrontFee(deposit);

    const commissionBefore = await ethers.provider.getBalance(commission.address);

    const regTx = await vault.connect(testator).registerInheritance(heir.address, { value: deposit });
    await expect(regTx).to.emit(vault, "InheritanceRegistered");
    await expect(regTx).to.emit(vault, "FeeApplied").withArgs(testator.address, bps, cap, fee, deposit);

    const details = await vault.getInheritanceDetails();
    expect(details[0]).to.equal(heir.address); // heir
    expect(details[4]).to.equal(0); // Status.Active (enum: Active=0)

    const net = deposit - fee;
    expect(await vault.inheritanceAmount()).to.equal(net);

    const commissionAfter = await ethers.provider.getBalance(commission.address);
    expect(commissionAfter - commissionBefore).to.equal(fee);
  });

  it("VaultPro: topUp applies fee per operation and updates lastCheckIn", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    const deposit = parseEther("1");
    const topup = parseEther("0.5");

    const fee1 = computeUpfrontFee(deposit);
    const fee2 = computeUpfrontFee(topup);

    await (await vault.connect(testator).registerInheritance(heir.address, { value: deposit })).wait();
    const last1 = await vault.lastCheckIn();

    await mineAndIncreaseTime(5);

    const tTx = await vault.connect(testator).topUp({ value: topup });
    await expect(tTx).to.emit(vault, "TopUpPerformed");
    await expect(tTx).to.emit(vault, "FeeApplied").withArgs(testator.address, fee2.bps, fee2.cap, fee2.fee, topup);

    const netTotal = (deposit - fee1.fee) + (topup - fee2.fee);
    expect(await vault.inheritanceAmount()).to.equal(netTotal);

    const last2 = await vault.lastCheckIn();
    expect(last2).to.be.greaterThan(last1);
  });

  it("VaultPro: setBeneficiaries enforces EOA-only, no duplicates, sum=10000", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    await (await vault.connect(testator).registerInheritance(heir.address, { value: parseEther("1") })).wait();

    // EOA-only: use another deployed vault as a "contract address" beneficiary
    const dummy = await (await Vault.connect(testator).deploy(testator.address, 123, commission.address)).waitForDeployment();

    await expect(
      vault.connect(testator).setBeneficiaries([dummy.target], [10000])
    ).to.be.revertedWith("Beneficiary must be EOA");

    // duplicates
    await expect(
      vault.connect(testator).setBeneficiaries([b1.address, b1.address], [5000, 5000])
    ).to.be.revertedWith("Duplicate beneficiary");

    // sum != 10000
    await expect(
      vault.connect(testator).setBeneficiaries([b1.address, b2.address], [5000, 4000])
    ).to.be.revertedWith("Bps must sum 10000");

    // ok
    const okTx = await vault.connect(testator).setBeneficiaries([b1.address, b2.address], [6000, 4000]);
    await expect(okTx).to.emit(vault, "BeneficiariesSet");

    const [recips, bps] = await vault.getBeneficiaries();
    expect(recips.length).to.equal(2);
    expect(recips[0]).to.equal(b1.address);
    expect(recips[1]).to.equal(b2.address);
    expect(bps[0]).to.equal(6000);
    expect(bps[1]).to.equal(4000);

    // empty clears
    await (await vault.connect(testator).setBeneficiaries([], [])).wait();
    const [recips2, bps2] = await vault.getBeneficiaries();
    expect(recips2.length).to.equal(0);
    expect(bps2.length).to.equal(0);
  });

  it("VaultPro: claim with splits distributes as expected", async function () {
    // Use short inactivity for fast test
    const tx = await factory.connect(testator).createInheritanceVault(shortInactivity);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    const deposit = parseEther("1");
    const topup = parseEther("0.5");
    const fee1 = computeUpfrontFee(deposit);
    const fee2 = computeUpfrontFee(topup);

    await (await vault.connect(testator).registerInheritance(heir.address, { value: deposit })).wait();
    await (await vault.connect(testator).topUp({ value: topup })).wait();

    // beneficiaries: b1 60%, b2 40%
    await (await vault.connect(testator).setBeneficiaries([b1.address, b2.address], [6000, 4000])).wait();

    const total = (deposit - fee1.fee) + (topup - fee2.fee);

    const b1Before = await ethers.provider.getBalance(b1.address);
    const b2Before = await ethers.provider.getBalance(b2.address);

    // advance time to become claimable
    await mineAndIncreaseTime(shortInactivity + 1);

    // claim must be called by heir (but heir is NOT a beneficiary here)
    const claimTx = await vault.connect(heir).claimInheritance();
    await expect(claimTx).to.emit(vault, "InheritanceReleased");

    const b1After = await ethers.provider.getBalance(b1.address);
    const b2After = await ethers.provider.getBalance(b2.address);

    const b1Exp = (total * 6000n) / 10000n;
    const b2Exp = (total * 4000n) / 10000n;
    const rem = total - (b1Exp + b2Exp); // remainder goes to b1 in contract

    expect(b1After - b1Before).to.equal(b1Exp + rem);
    expect(b2After - b2Before).to.equal(b2Exp);

    const details = await vault.getInheritanceDetails();
    expect(details[4]).to.equal(1); // Status.Released (Released=1)
  });

  it("VaultPro: claim with no beneficiaries transfers all to heir", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(shortInactivity);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    const deposit = parseEther("1");
    const fee1 = computeUpfrontFee(deposit);

    await (await vault.connect(testator).registerInheritance(heir.address, { value: deposit })).wait();

    const heirBefore = await ethers.provider.getBalance(heir.address);
    await mineAndIncreaseTime(shortInactivity + 1);

    // heir calls claim, heir receives funds but pays gas; so check vault balance goes to 0
    await (await vault.connect(heir).claimInheritance()).wait();

    const vaultBal = await ethers.provider.getBalance(vault.target);
    expect(vaultBal).to.equal(0n);

    // Optional: check heir increased approximately by net (gas makes exact check noisy)
    const net = deposit - fee1.fee;
    const heirAfter = await ethers.provider.getBalance(heir.address);
    expect(heirAfter).to.be.greaterThan(heirBefore); // loose check
    // If querés exactitud, usá beneficiary distinto del sender (como en el split test).
  });

  it("VaultPro: cancelInheritance refunds full vault balance to testator", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    await (await vault.connect(testator).registerInheritance(heir.address, { value: parseEther("1") })).wait();

    const balBefore = await ethers.provider.getBalance(vault.target);
    expect(balBefore).to.be.greaterThan(0n);

    await (await vault.connect(testator).cancelInheritance()).wait();
    const balAfter = await ethers.provider.getBalance(vault.target);
    expect(balAfter).to.equal(0n);

    const details = await vault.getInheritanceDetails();
    expect(details[4]).to.equal(2); // Status.Cancelled (Cancelled=2)
  });

  it("VaultPro: helpers claimableAt / isClaimable behave correctly", async function () {
    const tx = await factory.connect(testator).createInheritanceVault(shortInactivity);
    const receipt = await tx.wait();
    const vaultAddress = receipt.logs.find((l) => l.fragment && l.fragment.name === "VaultCreated").args.vaultAddress;

    const Vault = await ethers.getContractFactory("InheritanceVaultPro");
    const vault = await Vault.attach(vaultAddress);

    await (await vault.connect(testator).registerInheritance(heir.address, { value: parseEther("1") })).wait();

    expect(await vault.isClaimable()).to.equal(false);

    const t = await vault.claimableAt();
    const nowBlock = await ethers.provider.getBlock("latest");
    expect(t).to.be.greaterThan(nowBlock.timestamp);

    await mineAndIncreaseTime(shortInactivity + 1);
    expect(await vault.isClaimable()).to.equal(true);
  });
});