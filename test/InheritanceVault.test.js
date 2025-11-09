const { expect } = require("chai");
const hre = require("hardhat");
const ethers = hre.ethers;
const parseEther = hre.ethers.parseEther;
const toWei = (s) => hre.ethers.parseEther(s);

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
  //BΔLT-002
  it("should update lastCheckIn on registerInheritance", async () => {
    const Factory = await ethers.getContractFactory("InheritanceFactory");
    const tempFactory = await Factory.deploy(testator.address);
    await tempFactory.waitForDeployment();

    const tx = await tempFactory.connect(testator).createInheritanceVault(inactivityPeriod);
    await tx.wait();

    const vaultAddresses = await tempFactory.getVaultsByTestator(testator.address);
    const tempVaultAddress = vaultAddresses[vaultAddresses.length - 1];

    const Vault = await ethers.getContractFactory("InheritanceVault");
    const tempVault = await Vault.attach(tempVaultAddress);

    const detailsBefore = await tempVault.getInheritanceDetails();
    const prevLastCheckIn = detailsBefore[2];

    await ethers.provider.send("evm_increaseTime", [100]);
    await ethers.provider.send("evm_mine");

    await tempVault.connect(testator).registerInheritance(heir.address, {
    value: parseEther("1"),
  });

  const detailsAfter = await tempVault.getInheritanceDetails();
  expect(detailsAfter[2]).to.be.gt(prevLastCheckIn);
});
//BΔLT-002 END
//BΔLT-003
it("should revert if deposit is below minimum (1000 satoshis)", async () => {  
  const tx = await factory.connect(testator).createInheritanceVault(inactivityPeriod);
  await tx.wait();

  const vaultAddresses = await factory.getVaultsByTestator(testator.address);
  const freshVaultAddress = vaultAddresses[vaultAddresses.length - 1];

  const Vault = await ethers.getContractFactory("InheritanceVault");
  const freshVault = await Vault.attach(freshVaultAddress);

  const tinyDeposit = hre.ethers.parseUnits("0.000000009", "ether"); // 900 satoshis

  await expect(
    freshVault.connect(testator).registerInheritance(heir.address, {
      value: tinyDeposit,
    })
  ).to.be.revertedWith("Deposit too small, minimum is 1000 satoshis");
});
//BΔLT-003 END
//BΔLT-006
it("should revert if heir is the zero address", async function () {
  await expect(
    vault.connect(testator).registerInheritance(ethers.ZeroAddress, { value: depositAmount })
  ).to.be.revertedWith("Invalid heir address");
});
//BΔLT-006 END

describe("Fees & Caps (standalone)", function () {
  const inactivityPeriod = 60 * 60 * 24 * 30;
  const toWei = (s) => hre.ethers.parseEther(s);

  let testator, heir, other;

  beforeEach(async () => {
    [testator, heir, other] = await ethers.getSigners();
  });

  async function newVaultWithCommission(commissionWallet) {
    const Factory = await ethers.getContractFactory("InheritanceFactory");
    const f = await Factory.deploy(commissionWallet);
    await f.waitForDeployment();

    await f.connect(testator).createInheritanceVault(inactivityPeriod);
    const addrs = await f.getVaultsByTestator(testator.address);
    const vAddr = addrs[addrs.length - 1];

    const Vault = await ethers.getContractFactory("InheritanceVault");
    return { f, v: await Vault.attach(vAddr) };
  }

  it("fee free-tier: <= 0.01 BTC cobra 0 y bps/cap = 0", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("0.01");
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 0, 0, 0, dep);
    expect(await v.inheritanceAmount()).to.equal(dep);
  });

  it("fee 0.8% para 0.25 BTC sin cap (fee=0.002)", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("0.25");
    const expectedFee = toWei("0.002");
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 80, toWei("0.20"), expectedFee, dep);
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
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 70, toWei("0.20"), expectedFee, dep);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("cap 0.20 en 50 BTC: raw=0.30 (0.6%) pero fee=0.20", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("50");
    const expectedFee = toWei("0.20");
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 60, toWei("0.20"), expectedFee, dep);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("cap 0.30 en 100 BTC: raw=0.60 (0.6%) pero fee=0.30", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("100");
    const expectedFee = toWei("0.30");
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 60, toWei("0.30"), expectedFee, dep);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("cap 0.50 en 1000 BTC: raw=5.0 (0.5%) pero fee=0.50", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("1000");
    const expectedFee = toWei("0.50");
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 50, toWei("0.50"), expectedFee, dep);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it(">1000 BTC usa cap 0.75 (p.ej., 1200 BTC → fee=0.75)", async () => {
    const { v } = await newVaultWithCommission(testator.address);
    const dep = toWei("1200");
    const expectedFee = toWei("0.75");
    await expect(
      v.connect(testator).registerInheritance(heir.address, { value: dep })
    ).to.emit(v, "FeeApplied").withArgs(testator.address, 50, toWei("0.75"), expectedFee, dep);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });

  it("bps boundaries inclusivos: 5→80bps, 30→70bps, 100→60bps", async () => {
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("5");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 80, toWei("0.20"), toWei("0.04"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("30");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 70, toWei("0.20"), toWei("0.20"), dep); // capped
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("100");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 60, toWei("0.30"), toWei("0.30"), dep);
    }
  });

  it("cap boundaries inclusivos: 50→0.20, 250→0.30, 500→0.40, 1000→0.50", async () => {
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("50");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 60, toWei("0.20"), toWei("0.20"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("250");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 50, toWei("0.30"), toWei("0.30"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("500");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 50, toWei("0.40"), toWei("0.40"), dep);
    }
    {
      const { v } = await newVaultWithCommission(testator.address);
      const dep = toWei("1000");
      await expect(
        v.connect(testator).registerInheritance(heir.address, { value: dep })
      ).to.emit(v, "FeeApplied").withArgs(testator.address, 50, toWei("0.50"), toWei("0.50"), dep);
    }
  });

  it("transfiere la comisión a la commissionWallet (usando 'other' como wallet)", async () => {
    const { v } = await newVaultWithCommission(other.address);
    const dep = toWei("25"); // 0.7% → 0.175
    const expectedFee = toWei("0.175");

    const before = await ethers.provider.getBalance(other.address);
    await v.connect(testator).registerInheritance(heir.address, { value: dep });
    const after = await ethers.provider.getBalance(other.address);

    expect(after - before).to.equal(expectedFee);
    expect(await v.inheritanceAmount()).to.equal(dep - expectedFee);
  });
});

});