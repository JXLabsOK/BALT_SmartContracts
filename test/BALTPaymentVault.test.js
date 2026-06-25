// test/BALTPaymentVault.test.js
const { expect } = require("chai");
const hre = require("hardhat");

const { ethers } = hre;
const parseUnits = ethers.parseUnits;

describe("BALTPaymentVault", function () {
  let admin, payer, recipient1, recipient2, recipient3, other;
  let registry, token, otherToken, vault;

  const shortInactivity = 60; // 60 seconds for fast tests
  const subscriptionDuration = 60 * 60 * 24 * 30; // 30 days

  const amount1 = parseUnits("100", 18);
  const amount2 = parseUnits("250", 18);
  const amount3 = parseUnits("50", 18);
  const totalAmount = amount1 + amount2;

  async function mineAndIncreaseTime(seconds) {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
  }

  async function getFutureTimestamp(secondsFromNow) {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block.timestamp) + BigInt(secondsFromNow);
  }

  async function activateSubscription(account) {
    const expiration = await getFutureTimestamp(subscriptionDuration);

    await (
      await registry
        .connect(admin)
        .setSubscription(account.address, expiration)
    ).wait();
  }

  async function deployVault(customToken = token.target, customRegistry = registry.target, period = shortInactivity) {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    const deployedVault = await Vault
      .connect(payer)
      .deploy(
        payer.address,
        customToken,
        period,
        customRegistry
      );

    await deployedVault.waitForDeployment();

    return deployedVault;
  }

  async function approveAndRegisterPayment(
    recipients = [recipient1.address, recipient2.address],
    amounts = [amount1, amount2],
    total = totalAmount
  ) {
    await (
      await token
        .connect(payer)
        .approve(vault.target, total)
    ).wait();

    return vault
      .connect(payer)
      .registerPayment(total, recipients, amounts);
  }

  beforeEach(async () => {
    [admin, payer, recipient1, recipient2, recipient3, other] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("BALTPaymentsSubscriptionRegistry");
    registry = await Registry.connect(admin).deploy();
    await registry.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");

    token = await MockERC20.connect(admin).deploy();
    await token.waitForDeployment();

    otherToken = await MockERC20.connect(admin).deploy();
    await otherToken.waitForDeployment();

    await activateSubscription(payer);

    await (
      await token
        .connect(admin)
        .mint(payer.address, parseUnits("100000", 18))
    ).wait();

    await (
      await otherToken
        .connect(admin)
        .mint(payer.address, parseUnits("100000", 18))
    ).wait();

    vault = await deployVault();
  });

  // ---------------- Deployment ----------------

  it("should deploy with the expected constructor values", async function () {
    expect(await vault.payer()).to.equal(payer.address);
    expect(await vault.paymentToken()).to.equal(token.target);
    expect(await vault.subscriptionRegistry()).to.equal(registry.target);
    expect(await vault.inactivityPeriod()).to.equal(shortInactivity);
    expect(await vault.paymentStatus()).to.equal(0); // Status.Idle
    expect(await vault.paymentId()).to.equal(0);
  });

  it("should revert if deployed with zero payer", async function () {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    await expect(
      Vault
        .connect(payer)
        .deploy(
          ethers.ZeroAddress,
          token.target,
          shortInactivity,
          registry.target
        )
    ).to.be.revertedWith("Invalid payer");
  });

  it("should revert if deployed with zero payment token", async function () {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    await expect(
      Vault
        .connect(payer)
        .deploy(
          payer.address,
          ethers.ZeroAddress,
          shortInactivity,
          registry.target
        )
    ).to.be.revertedWith("Invalid payment token");
  });

  it("should revert if deployed with zero subscription registry", async function () {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    await expect(
      Vault
        .connect(payer)
        .deploy(
          payer.address,
          token.target,
          shortInactivity,
          ethers.ZeroAddress
        )
    ).to.be.revertedWith("Invalid subscription registry");
  });

  it("should revert if payment token is not a contract", async function () {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    await expect(
      Vault
        .connect(payer)
        .deploy(
          payer.address,
          other.address,
          shortInactivity,
          registry.target
        )
    ).to.be.revertedWith("Payment token must be contract");
  });

  it("should revert if subscription registry is not a contract", async function () {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    await expect(
      Vault
        .connect(payer)
        .deploy(
          payer.address,
          token.target,
          shortInactivity,
          other.address
        )
    ).to.be.revertedWith("Subscription registry must be contract");
  });

  it("should revert if inactivity period is zero", async function () {
    const Vault = await ethers.getContractFactory("BALTPaymentVault");

    await expect(
      Vault
        .connect(payer)
        .deploy(
          payer.address,
          token.target,
          0,
          registry.target
        )
    ).to.be.revertedWith("Invalid inactivity period");
  });

  it("should reject native token transfers", async function () {
    await expect(
      payer.sendTransaction({
        to: vault.target,
        value: parseUnits("1", 18),
      })
    ).to.be.revertedWith("Native token not accepted");
  });

  // ---------------- registerPayment ----------------

  it("should register a payment and pull the exact ERC-20 amount", async function () {
    const payerBefore = await token.balanceOf(payer.address);
    const vaultBefore = await token.balanceOf(vault.target);

    const tx = await approveAndRegisterPayment();

    await expect(tx).to.emit(vault, "PaymentRegistered");

    const payerAfter = await token.balanceOf(payer.address);
    const vaultAfter = await token.balanceOf(vault.target);

    expect(payerBefore - payerAfter).to.equal(totalAmount);
    expect(vaultAfter - vaultBefore).to.equal(totalAmount);

    expect(await vault.paymentId()).to.equal(1);
    expect(await vault.totalPaymentAmount()).to.equal(totalAmount);
    expect(await vault.totalClaimed()).to.equal(0);
    expect(await vault.recipientCount()).to.equal(2);
    expect(await vault.claimedCount()).to.equal(0);
    expect(await vault.paymentStatus()).to.equal(1); // Status.Active
  });

  it("should store recipients, amounts, and claimed status", async function () {
    await (await approveAndRegisterPayment()).wait();

    const [recipients, amounts, claimed] = await vault.getRecipients();

    expect(recipients.length).to.equal(2);
    expect(recipients[0]).to.equal(recipient1.address);
    expect(recipients[1]).to.equal(recipient2.address);

    expect(amounts[0]).to.equal(amount1);
    expect(amounts[1]).to.equal(amount2);

    expect(claimed[0]).to.equal(false);
    expect(claimed[1]).to.equal(false);
  });

  it("should revert if non-payer tries to register a payment", async function () {
    await expect(
      vault
        .connect(other)
        .registerPayment(totalAmount, [recipient1.address, recipient2.address], [amount1, amount2])
    ).to.be.revertedWith("Only payer");
  });

  it("should revert if payer subscription is inactive", async function () {
    await (
      await registry
        .connect(admin)
        .deactivateSubscription(payer.address)
    ).wait();

    await (
      await token
        .connect(payer)
        .approve(vault.target, totalAmount)
    ).wait();

    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [recipient1.address, recipient2.address], [amount1, amount2])
    ).to.be.revertedWith("Subscription inactive");
  });

  it("should revert if total amount is zero", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(0, [recipient1.address], [amount1])
    ).to.be.revertedWith("Invalid total amount");
  });

  it("should revert if recipients list is empty", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [], [])
    ).to.be.revertedWith("No recipients");
  });

  it("should revert on recipients and amounts length mismatch", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [recipient1.address, recipient2.address], [amount1])
    ).to.be.revertedWith("Length mismatch");
  });

  it("should revert if there are too many recipients", async function () {
    const recipients = [];
    const amounts = [];

    for (let i = 0; i < 101; i++) {
      recipients.push(ethers.Wallet.createRandom().address);
      amounts.push(1n);
    }

    await expect(
      vault
        .connect(payer)
        .registerPayment(101n, recipients, amounts)
    ).to.be.revertedWith("Too many recipients");
  });

  it("should revert if recipient is zero address", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(amount1, [ethers.ZeroAddress], [amount1])
    ).to.be.revertedWith("Invalid recipient");
  });

  it("should revert if recipient amount is zero", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(amount1, [recipient1.address], [0])
    ).to.be.revertedWith("Invalid recipient amount");
  });

  it("should revert on duplicate recipient", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [recipient1.address, recipient1.address], [amount1, amount2])
    ).to.be.revertedWith("Duplicate recipient");
  });

  it("should revert if recipient amounts do not match total", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [recipient1.address, recipient2.address], [amount1, amount3])
    ).to.be.revertedWith("Amounts must match total");
  });

  it("should revert if allowance is insufficient", async function () {
    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [recipient1.address, recipient2.address], [amount1, amount2])
    ).to.be.revertedWith("Insufficient allowance");
  });

  it("should revert if trying to register another payment while active", async function () {
    await (await approveAndRegisterPayment()).wait();

    await (
      await token
        .connect(payer)
        .approve(vault.target, totalAmount)
    ).wait();

    await expect(
      vault
        .connect(payer)
        .registerPayment(totalAmount, [recipient1.address, recipient2.address], [amount1, amount2])
    ).to.be.revertedWith("Payment already active");
  });

  // ---------------- performCheckIn ----------------

  it("should allow payer to perform check-in before payment is claimable", async function () {
    await (await approveAndRegisterPayment()).wait();

    const previousLastCheckIn = await vault.lastCheckIn();

    await mineAndIncreaseTime(5);

    const tx = await vault
      .connect(payer)
      .performCheckIn();

    await expect(tx).to.emit(vault, "CheckInPerformed");

    const newLastCheckIn = await vault.lastCheckIn();
    expect(newLastCheckIn).to.be.greaterThan(previousLastCheckIn);
  });

  it("should revert if non-payer tries to perform check-in", async function () {
    await (await approveAndRegisterPayment()).wait();

    await expect(
      vault
        .connect(other)
        .performCheckIn()
    ).to.be.revertedWith("Only payer");
  });

  it("should revert check-in if payment is not active", async function () {
    await expect(
      vault
        .connect(payer)
        .performCheckIn()
    ).to.be.revertedWith("Payment is not active");
  });

  it("should revert check-in if subscription is inactive", async function () {
    await (await approveAndRegisterPayment()).wait();

    await (
      await registry
        .connect(admin)
        .deactivateSubscription(payer.address)
    ).wait();

    await expect(
      vault
        .connect(payer)
        .performCheckIn()
    ).to.be.revertedWith("Subscription inactive");
  });

  it("should revert check-in after payment becomes claimable", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await expect(
      vault
        .connect(payer)
        .performCheckIn()
    ).to.be.revertedWith("Payment already claimable");
  });

  // ---------------- claimPayment ----------------

  it("should report claimableAt and isClaimable correctly", async function () {
    await (await approveAndRegisterPayment()).wait();

    expect(await vault.isClaimable()).to.equal(false);

    const claimableAt = await vault.claimableAt();
    const block = await ethers.provider.getBlock("latest");

    expect(claimableAt).to.be.greaterThan(block.timestamp);

    await mineAndIncreaseTime(shortInactivity + 1);

    expect(await vault.isClaimable()).to.equal(true);
  });

  it("should revert claim before claimableAt", async function () {
    await (await approveAndRegisterPayment()).wait();

    await expect(
      vault
        .connect(recipient1)
        .claimPayment()
    ).to.be.revertedWith("Payment is not claimable yet");
  });

  it("should revert claim from non-recipient", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await expect(
      vault
        .connect(other)
        .claimPayment()
    ).to.be.revertedWith("No payment assigned");
  });

  it("should allow recipient to claim assigned amount", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    const before = await token.balanceOf(recipient1.address);

    const tx = await vault
      .connect(recipient1)
      .claimPayment();

    await expect(tx)
      .to.emit(vault, "PaymentClaimed")
      .withArgs(recipient1.address, 1, amount1);

    const after = await token.balanceOf(recipient1.address);

    expect(after - before).to.equal(amount1);
    expect(await vault.totalClaimed()).to.equal(amount1);
    expect(await vault.claimedCount()).to.equal(1);
    expect(await vault.hasRecipientClaimed(recipient1.address)).to.equal(true);
    expect(await vault.paymentStatus()).to.equal(1); // Status.Active
  });

  it("should prevent double claim", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await (
      await vault
        .connect(recipient1)
        .claimPayment()
    ).wait();

    await expect(
      vault
        .connect(recipient1)
        .claimPayment()
    ).to.be.revertedWith("Payment already claimed");
  });

  it("should set status to Released when all recipients claim", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await (
      await vault
        .connect(recipient1)
        .claimPayment()
    ).wait();

    const tx = await vault
      .connect(recipient2)
      .claimPayment();

    await expect(tx)
      .to.emit(vault, "PaymentReleased")
      .withArgs(1, totalAmount);

    expect(await vault.totalClaimed()).to.equal(totalAmount);
    expect(await vault.claimedCount()).to.equal(2);
    expect(await vault.paymentStatus()).to.equal(2); // Status.Released
    expect(await token.balanceOf(vault.target)).to.equal(0);
  });

  it("should revert claim after claim window expired", async function () {
    await (await approveAndRegisterPayment()).wait();

    const claimWindow = await vault.CLAIM_WINDOW();

    await mineAndIncreaseTime(shortInactivity + Number(claimWindow) + 1);

    expect(await vault.isClaimExpired()).to.equal(true);

    await expect(
      vault
        .connect(recipient1)
        .claimPayment()
    ).to.be.revertedWith("Claim window expired");
  });

  // ---------------- cancelPayment ----------------

  it("should allow payer to cancel before payment is claimable", async function () {
    await (await approveAndRegisterPayment()).wait();

    const payerBefore = await token.balanceOf(payer.address);

    const tx = await vault
      .connect(payer)
      .cancelPayment();

    await expect(tx)
      .to.emit(vault, "PaymentCancelled")
      .withArgs(payer.address, 1, totalAmount);

    const payerAfter = await token.balanceOf(payer.address);

    expect(payerAfter - payerBefore).to.equal(totalAmount);
    expect(await vault.paymentStatus()).to.equal(3); // Status.Cancelled
    expect(await token.balanceOf(vault.target)).to.equal(0);
  });

  it("should revert cancel from non-payer", async function () {
    await (await approveAndRegisterPayment()).wait();

    await expect(
      vault
        .connect(other)
        .cancelPayment()
    ).to.be.revertedWith("Only payer");
  });

  it("should revert cancel after payment is claimable", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await expect(
      vault
        .connect(payer)
        .cancelPayment()
    ).to.be.revertedWith("Payment already claimable");
  });

  // ---------------- closeExpiredPayment ----------------

  it("should revert closeExpiredPayment before claim window expires", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await expect(
      vault
        .connect(payer)
        .closeExpiredPayment()
    ).to.be.revertedWith("Claim window not expired");
  });

  it("should allow payer to close expired payment and recover all unclaimed funds", async function () {
    await (await approveAndRegisterPayment()).wait();

    const claimWindow = await vault.CLAIM_WINDOW();

    await mineAndIncreaseTime(shortInactivity + Number(claimWindow) + 1);

    const payerBefore = await token.balanceOf(payer.address);

    const tx = await vault
      .connect(payer)
      .closeExpiredPayment();

    await expect(tx)
      .to.emit(vault, "PaymentClosed")
      .withArgs(payer.address, 1, totalAmount);

    const payerAfter = await token.balanceOf(payer.address);

    expect(payerAfter - payerBefore).to.equal(totalAmount);
    expect(await vault.paymentStatus()).to.equal(4); // Status.Closed
    expect(await token.balanceOf(vault.target)).to.equal(0);
  });

  it("should close expired payment and recover only unclaimed funds after partial claims", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await (
      await vault
        .connect(recipient1)
        .claimPayment()
    ).wait();

    const claimWindow = await vault.CLAIM_WINDOW();

    await mineAndIncreaseTime(Number(claimWindow) + 1);

    const payerBefore = await token.balanceOf(payer.address);

    const tx = await vault
      .connect(payer)
      .closeExpiredPayment();

    await expect(tx)
      .to.emit(vault, "PaymentClosed")
      .withArgs(payer.address, 1, amount2);

    const payerAfter = await token.balanceOf(payer.address);

    expect(payerAfter - payerBefore).to.equal(amount2);
    expect(await vault.totalClaimed()).to.equal(amount1);
    expect(await vault.paymentStatus()).to.equal(4); // Status.Closed
    expect(await token.balanceOf(vault.target)).to.equal(0);
  });

  it("should revert closeExpiredPayment from non-payer", async function () {
    await (await approveAndRegisterPayment()).wait();

    const claimWindow = await vault.CLAIM_WINDOW();

    await mineAndIncreaseTime(shortInactivity + Number(claimWindow) + 1);

    await expect(
      vault
        .connect(other)
        .closeExpiredPayment()
    ).to.be.revertedWith("Only payer");
  });

  // ---------------- Vault reuse ----------------

  it("should allow vault reuse after Released", async function () {
    await (await approveAndRegisterPayment()).wait();

    await mineAndIncreaseTime(shortInactivity + 1);

    await (
      await vault
        .connect(recipient1)
        .claimPayment()
    ).wait();

    await (
      await vault
        .connect(recipient2)
        .claimPayment()
    ).wait();

    expect(await vault.paymentStatus()).to.equal(2); // Status.Released

    await (
      await token
        .connect(payer)
        .approve(vault.target, amount3)
    ).wait();

    await (
      await vault
        .connect(payer)
        .registerPayment(amount3, [recipient3.address], [amount3])
    ).wait();

    expect(await vault.paymentId()).to.equal(2);
    expect(await vault.paymentStatus()).to.equal(1); // Status.Active
    expect(await vault.totalPaymentAmount()).to.equal(amount3);
    expect(await vault.recipientCount()).to.equal(1);

    const [recipients, amounts, claimed] = await vault.getRecipients();

    expect(recipients.length).to.equal(1);
    expect(recipients[0]).to.equal(recipient3.address);
    expect(amounts[0]).to.equal(amount3);
    expect(claimed[0]).to.equal(false);
  });

  it("should allow vault reuse after Cancelled", async function () {
    await (await approveAndRegisterPayment()).wait();
    await (await vault.connect(payer).cancelPayment()).wait();

    expect(await vault.paymentStatus()).to.equal(3); // Status.Cancelled

    await (
      await token
        .connect(payer)
        .approve(vault.target, amount3)
    ).wait();

    await (
      await vault
        .connect(payer)
        .registerPayment(amount3, [recipient3.address], [amount3])
    ).wait();

    expect(await vault.paymentId()).to.equal(2);
    expect(await vault.paymentStatus()).to.equal(1); // Status.Active
  });

  it("should allow vault reuse after Closed", async function () {
    await (await approveAndRegisterPayment()).wait();

    const claimWindow = await vault.CLAIM_WINDOW();

    await mineAndIncreaseTime(shortInactivity + Number(claimWindow) + 1);

    await (
        await vault
        .connect(payer)
        .closeExpiredPayment()
    ).wait();

    expect(await vault.paymentStatus()).to.equal(4); // Status.Closed

    // The subscription expired during the claim window, so it must be renewed before starting a new payment.
    await activateSubscription(payer);

    await (
        await token
        .connect(payer)
        .approve(vault.target, amount3)
    ).wait();

    await (
        await vault
        .connect(payer)
        .registerPayment(amount3, [recipient3.address], [amount3])
    ).wait();

    expect(await vault.paymentId()).to.equal(2);
    expect(await vault.paymentStatus()).to.equal(1); // Status.Active
  });

  it("should revert vault reuse after Closed if subscription is inactive", async function () {
    await (await approveAndRegisterPayment()).wait();

    const claimWindow = await vault.CLAIM_WINDOW();

    await mineAndIncreaseTime(shortInactivity + Number(claimWindow) + 1);

    await (
        await vault
        .connect(payer)
        .closeExpiredPayment()
    ).wait();

    expect(await vault.paymentStatus()).to.equal(4); // Status.Closed

    await (
        await token
        .connect(payer)
        .approve(vault.target, amount3)
    ).wait();

    await expect(
        vault
        .connect(payer)
        .registerPayment(amount3, [recipient3.address], [amount3])
    ).to.be.revertedWith("Subscription inactive");
  });
  
  // ---------------- recoverExcessToken ----------------

  it("should recover excess payment token without touching pending funds", async function () {
    await (await approveAndRegisterPayment()).wait();

    const excess = parseUnits("10", 18);

    await (
      await token
        .connect(admin)
        .mint(vault.target, excess)
    ).wait();

    const payerBefore = await token.balanceOf(payer.address);

    const tx = await vault
      .connect(payer)
      .recoverExcessToken(token.target, excess);

    await expect(tx)
      .to.emit(vault, "ExcessTokenRecovered")
      .withArgs(token.target, payer.address, excess);

    const payerAfter = await token.balanceOf(payer.address);

    expect(payerAfter - payerBefore).to.equal(excess);
    expect(await token.balanceOf(vault.target)).to.equal(totalAmount);
  });

  it("should revert when trying to recover pending payment token funds", async function () {
    await (await approveAndRegisterPayment()).wait();

    await expect(
      vault
        .connect(payer)
        .recoverExcessToken(token.target, amount1)
    ).to.be.revertedWith("No excess token");
  });

  it("should revert when trying to recover more than excess payment token", async function () {
    await (await approveAndRegisterPayment()).wait();

    const excess = parseUnits("10", 18);

    await (
      await token
        .connect(admin)
        .mint(vault.target, excess)
    ).wait();

    await expect(
      vault
        .connect(payer)
        .recoverExcessToken(token.target, excess + 1n)
    ).to.be.revertedWith("Amount exceeds excess");
  });

  it("should recover unrelated ERC-20 tokens sent by mistake", async function () {
    const mistakenAmount = parseUnits("25", 18);

    await (
      await otherToken
        .connect(admin)
        .mint(vault.target, mistakenAmount)
    ).wait();

    const payerBefore = await otherToken.balanceOf(payer.address);

    await (
      await vault
        .connect(payer)
        .recoverExcessToken(otherToken.target, mistakenAmount)
    ).wait();

    const payerAfter = await otherToken.balanceOf(payer.address);

    expect(payerAfter - payerBefore).to.equal(mistakenAmount);
    expect(await otherToken.balanceOf(vault.target)).to.equal(0);
  });

  it("should revert recoverExcessToken from non-payer", async function () {
    const mistakenAmount = parseUnits("25", 18);

    await (
      await otherToken
        .connect(admin)
        .mint(vault.target, mistakenAmount)
    ).wait();

    await expect(
      vault
        .connect(other)
        .recoverExcessToken(otherToken.target, mistakenAmount)
    ).to.be.revertedWith("Only payer");
  });

  it("should revert recoverExcessToken with zero token address", async function () {
    await expect(
      vault
        .connect(payer)
        .recoverExcessToken(ethers.ZeroAddress, amount1)
    ).to.be.revertedWith("Invalid token");
  });

  it("should revert recoverExcessToken when token is not a contract", async function () {
    await expect(
      vault
        .connect(payer)
        .recoverExcessToken(other.address, amount1)
    ).to.be.revertedWith("Token must be contract");
  });

  it("should revert recoverExcessToken with zero amount", async function () {
    await expect(
      vault
        .connect(payer)
        .recoverExcessToken(token.target, 0)
    ).to.be.revertedWith("Invalid amount");
  });

  // ---------------- View helpers ----------------

  it("should return payment details", async function () {
    await (await approveAndRegisterPayment()).wait();

    const details = await vault.getPaymentDetails();

    expect(details[0]).to.equal(token.target); // paymentToken
    expect(details[1]).to.equal(1); // paymentId
    expect(details[2]).to.equal(totalAmount); // totalPaymentAmount
    expect(details[3]).to.equal(0); // totalClaimed
    expect(details[6]).to.equal(2); // recipientCount
    expect(details[7]).to.equal(0); // claimedCount
    expect(details[8]).to.equal(1); // Status.Active
  });

  it("should return amount due for current payment", async function () {
    await (await approveAndRegisterPayment()).wait();

    expect(await vault.getAmountDue(recipient1.address)).to.equal(amount1);
    expect(await vault.getAmountDue(recipient2.address)).to.equal(amount2);
    expect(await vault.getAmountDue(other.address)).to.equal(0);
  });

  it("should return pending amount", async function () {
    await (await approveAndRegisterPayment()).wait();

    expect(await vault.pendingAmount()).to.equal(totalAmount);

    await mineAndIncreaseTime(shortInactivity + 1);

    await (
      await vault
        .connect(recipient1)
        .claimPayment()
    ).wait();

    expect(await vault.pendingAmount()).to.equal(amount2);
  });

  it("should return recipients count", async function () {
    await (await approveAndRegisterPayment()).wait();

    expect(await vault.getRecipientsCount()).to.equal(2);
  });

  it("should return claim expiration timestamp", async function () {
    await (await approveAndRegisterPayment()).wait();

    const claimableAt = await vault.claimableAt();
    const claimExpiresAt = await vault.claimExpiresAt();
    const claimWindow = await vault.CLAIM_WINDOW();

    expect(claimExpiresAt).to.equal(claimableAt + claimWindow);
  });
});