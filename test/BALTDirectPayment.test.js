const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BALTDirectPayment", function () {
    const ZERO_ADDRESS = ethers.ZeroAddress;

    const DIRECT_PAYMENT_FEE_BPS = 35n;
    const BPS_DENOM = 10_000n;

    let deployer;
    let recipient;
    let payer;
    let payer2;
    let commissionWallet;
    let other;

    let token6;
    let token18;

    let nativePayment;
    let token6Payment;
    let token18Payment;

    async function deployDirectPayment(commission, asset) {
        const BALTDirectPayment = await ethers.getContractFactory("BALTDirectPayment");
        const contract = await BALTDirectPayment.deploy(commission, asset);
        await contract.waitForDeployment();
        return contract;
    }

    beforeEach(async function () {
        [
            deployer,
            recipient,
            payer,
            payer2,
            commissionWallet,
            other
        ] = await ethers.getSigners();

        const MockRequestERC20 = await ethers.getContractFactory("MockRequestERC20");

        token6 = await MockRequestERC20.deploy(
            "Mock USD6",
            "MUSD6",
            6
        );
        await token6.waitForDeployment();

        token18 = await MockRequestERC20.deploy(
            "Mock USD18",
            "MUSD18",
            18
        );
        await token18.waitForDeployment();

        await token6.mint(
            payer.address,
            ethers.parseUnits("100000", 6)
        );

        await token6.mint(
            payer2.address,
            ethers.parseUnits("100000", 6)
        );

        await token18.mint(
            payer.address,
            ethers.parseUnits("100000", 18)
        );

        nativePayment = await deployDirectPayment(
            commissionWallet.address,
            ZERO_ADDRESS
        );

        token6Payment = await deployDirectPayment(
            commissionWallet.address,
            await token6.getAddress()
        );

        token18Payment = await deployDirectPayment(
            commissionWallet.address,
            await token18.getAddress()
        );
    });

    describe("Deployment", function () {
        it("Should configure native asset deployment correctly", async function () {
            expect(
                await nativePayment.commissionWallet()
            ).to.equal(commissionWallet.address);

            expect(
                await nativePayment.paymentAsset()
            ).to.equal(ZERO_ADDRESS);

            expect(
                await nativePayment.DIRECT_PAYMENT_FEE_BPS()
            ).to.equal(DIRECT_PAYMENT_FEE_BPS);

            expect(
                await nativePayment.BPS_DENOM()
            ).to.equal(BPS_DENOM);
        });

        it("Should configure ERC20 deployment correctly", async function () {
            expect(
                await token6Payment.commissionWallet()
            ).to.equal(commissionWallet.address);

            expect(
                await token6Payment.paymentAsset()
            ).to.equal(await token6.getAddress());
        });

        it("Should reject zero commission wallet", async function () {
            const BALTDirectPayment =
                await ethers.getContractFactory("BALTDirectPayment");

            await expect(
                BALTDirectPayment.deploy(
                    ZERO_ADDRESS,
                    ZERO_ADDRESS
                )
            ).to.be.revertedWith(
                "Invalid commission wallet"
            );
        });

        it("Should reject an EOA as ERC20 asset", async function () {
            const BALTDirectPayment =
                await ethers.getContractFactory("BALTDirectPayment");

            await expect(
                BALTDirectPayment.deploy(
                    commissionWallet.address,
                    other.address
                )
            ).to.be.revertedWith(
                "Payment asset must be contract"
            );
        });

        it("Should reject direct native transfers", async function () {
            await expect(
                payer.sendTransaction({
                    to: await nativePayment.getAddress(),
                    value: ethers.parseEther("1")
                })
            ).to.be.revertedWith(
                "Direct transfer not accepted"
            );
        });
    });

    describe("Fee calculation", function () {
        it("Should calculate 0.35 percent fee correctly", async function () {
            const amount = ethers.parseEther("100");

            const expectedFee = ethers.parseEther("0.35");

            expect(
                await nativePayment.calculateFee(amount)
            ).to.equal(expectedFee);
        });

        it("Should calculate fee for 10 units correctly", async function () {
            const amount = ethers.parseEther("10");

            const expectedFee = ethers.parseEther("0.035");

            expect(
                await nativePayment.calculateFee(amount)
            ).to.equal(expectedFee);
        });

        it("Should calculate fee for 1000 units correctly", async function () {
            const amount = ethers.parseEther("1000");

            const expectedFee = ethers.parseEther("3.5");

            expect(
                await nativePayment.calculateFee(amount)
            ).to.equal(expectedFee);
        });

        it("Should calculate fee correctly for 6 decimal assets", async function () {
            const amount = ethers.parseUnits("100", 6);

            const expectedFee = ethers.parseUnits("0.35", 6);

            expect(
                await token6Payment.calculateFee(amount)
            ).to.equal(expectedFee);
        });

        it("Should round fee down using integer division", async function () {
            expect(
                await nativePayment.calculateFee(1)
            ).to.equal(0n);

            expect(
                await nativePayment.calculateFee(28)
            ).to.equal(0n);

            expect(
                await nativePayment.calculateFee(29)
            ).to.equal(0n);

            expect(
                await nativePayment.calculateFee(10000)
            ).to.equal(35n);
        });
    });

    describe("Native payments", function () {
        it("Should pay recipient exact merchant amount and commission exact fee", async function () {
            const amount = ethers.parseEther("10");
            const fee = await nativePayment.calculateFee(amount);
            const total = amount + fee;

            const recipientBefore =
                await ethers.provider.getBalance(recipient.address);

            const commissionBefore =
                await ethers.provider.getBalance(commissionWallet.address);

            await nativePayment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount,
                    { value: total }
                );

            const recipientAfter =
                await ethers.provider.getBalance(recipient.address);

            const commissionAfter =
                await ethers.provider.getBalance(commissionWallet.address);

            expect(
                recipientAfter - recipientBefore
            ).to.equal(amount);

            expect(
                commissionAfter - commissionBefore
            ).to.equal(fee);

            expect(
                await ethers.provider.getBalance(
                    await nativePayment.getAddress()
                )
            ).to.equal(0n);
        });

        it("Should emit PaymentExecuted correctly", async function () {
            const amount = ethers.parseEther("10");
            const fee = await nativePayment.calculateFee(amount);
            const total = amount + fee;

            await expect(
                nativePayment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount,
                        { value: total }
                    )
            )
                .to.emit(
                    nativePayment,
                    "PaymentExecuted"
                )
                .withArgs(
                    payer.address,
                    recipient.address,
                    amount,
                    fee
                );
        });

        it("Should support multiple independent payments", async function () {
            const amount1 = ethers.parseEther("1");
            const fee1 = await nativePayment.calculateFee(amount1);

            const amount2 = ethers.parseEther("2");
            const fee2 = await nativePayment.calculateFee(amount2);

            const recipientBefore =
                await ethers.provider.getBalance(recipient.address);

            await nativePayment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount1,
                    { value: amount1 + fee1 }
                );

            await nativePayment
                .connect(payer2)
                .pay(
                    recipient.address,
                    amount2,
                    { value: amount2 + fee2 }
                );

            const recipientAfter =
                await ethers.provider.getBalance(recipient.address);

            expect(
                recipientAfter - recipientBefore
            ).to.equal(amount1 + amount2);
        });

        it("Should support payments where calculated fee is zero", async function () {
            const amount = 1n;

            expect(
                await nativePayment.calculateFee(amount)
            ).to.equal(0n);

            const recipientBefore =
                await ethers.provider.getBalance(recipient.address);

            await nativePayment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount,
                    { value: amount }
                );

            const recipientAfter =
                await ethers.provider.getBalance(recipient.address);

            expect(
                recipientAfter - recipientBefore
            ).to.equal(amount);
        });

        it("Should reject zero recipient", async function () {
            const amount = ethers.parseEther("1");
            const fee = await nativePayment.calculateFee(amount);

            await expect(
                nativePayment
                    .connect(payer)
                    .pay(
                        ZERO_ADDRESS,
                        amount,
                        { value: amount + fee }
                    )
            ).to.be.revertedWith(
                "Invalid recipient"
            );
        });

        it("Should reject contract itself as recipient", async function () {
            const amount = ethers.parseEther("1");
            const fee = await nativePayment.calculateFee(amount);

            await expect(
                nativePayment
                    .connect(payer)
                    .pay(
                        await nativePayment.getAddress(),
                        amount,
                        { value: amount + fee }
                    )
            ).to.be.revertedWith(
                "Invalid recipient"
            );
        });

        it("Should reject zero amount", async function () {
            await expect(
                nativePayment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        0,
                        { value: 0 }
                    )
            ).to.be.revertedWith(
                "Invalid amount"
            );
        });

        it("Should reject native payment below required total", async function () {
            const amount = ethers.parseEther("10");
            const fee = await nativePayment.calculateFee(amount);
            const total = amount + fee;

            await expect(
                nativePayment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount,
                        { value: total - 1n }
                    )
            ).to.be.revertedWith(
                "Incorrect payment amount"
            );
        });

        it("Should reject native payment above required total", async function () {
            const amount = ethers.parseEther("10");
            const fee = await nativePayment.calculateFee(amount);
            const total = amount + fee;

            await expect(
                nativePayment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount,
                        { value: total + 1n }
                    )
            ).to.be.revertedWith(
                "Incorrect payment amount"
            );
        });
    });

    describe("ERC20 payments - 6 decimals", function () {
        it("Should transfer merchant amount and fee correctly", async function () {
            const amount = ethers.parseUnits("100", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total
                );

            const payerBefore =
                await token6.balanceOf(payer.address);

            const recipientBefore =
                await token6.balanceOf(recipient.address);

            const commissionBefore =
                await token6.balanceOf(commissionWallet.address);

            await token6Payment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount
                );

            const payerAfter =
                await token6.balanceOf(payer.address);

            const recipientAfter =
                await token6.balanceOf(recipient.address);

            const commissionAfter =
                await token6.balanceOf(commissionWallet.address);

            expect(
                payerBefore - payerAfter
            ).to.equal(total);

            expect(
                recipientAfter - recipientBefore
            ).to.equal(amount);

            expect(
                commissionAfter - commissionBefore
            ).to.equal(fee);

            expect(
                await token6.balanceOf(
                    await token6Payment.getAddress()
                )
            ).to.equal(0n);
        });

        it("Should emit PaymentExecuted correctly", async function () {
            const amount = ethers.parseUnits("10", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total
                );

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount
                    )
            )
                .to.emit(
                    token6Payment,
                    "PaymentExecuted"
                )
                .withArgs(
                    payer.address,
                    recipient.address,
                    amount,
                    fee
                );
        });

        it("Should consume exact required allowance", async function () {
            const amount = ethers.parseUnits("100", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total
                );

            await token6Payment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount
                );

            expect(
                await token6.allowance(
                    payer.address,
                    await token6Payment.getAddress()
                )
            ).to.equal(0n);
        });

        it("Should reject insufficient allowance", async function () {
            const amount = ethers.parseUnits("100", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total - 1n
                );

            const recipientBefore =
                await token6.balanceOf(recipient.address);

            const commissionBefore =
                await token6.balanceOf(commissionWallet.address);

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount
                    )
            ).to.be.revertedWith(
                "Token transferFrom failed"
            );

            expect(
                await token6.balanceOf(recipient.address)
            ).to.equal(recipientBefore);

            expect(
                await token6.balanceOf(commissionWallet.address)
            ).to.equal(commissionBefore);
        });

        it("Should reject payment without approval", async function () {
            const amount = ethers.parseUnits("100", 6);

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount
                    )
            ).to.be.revertedWith(
                "Token transferFrom failed"
            );
        });

        it("Should reject native value sent to ERC20 payment contract", async function () {
            const amount = ethers.parseUnits("100", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total
                );

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount,
                        { value: 1n }
                    )
            ).to.be.revertedWith(
                "Native value not accepted"
            );
        });

        it("Should reject zero recipient", async function () {
            const amount = ethers.parseUnits("100", 6);

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        ZERO_ADDRESS,
                        amount
                    )
            ).to.be.revertedWith(
                "Invalid recipient"
            );
        });

        it("Should reject contract itself as recipient", async function () {
            const amount = ethers.parseUnits("100", 6);

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        await token6Payment.getAddress(),
                        amount
                    )
            ).to.be.revertedWith(
                "Invalid recipient"
            );
        });

        it("Should reject zero amount", async function () {
            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        0
                    )
            ).to.be.revertedWith(
                "Invalid amount"
            );
        });
    });

    describe("ERC20 payments - 18 decimals", function () {
        it("Should transfer 18 decimal token correctly", async function () {
            const amount = ethers.parseUnits("100", 18);
            const fee = await token18Payment.calculateFee(amount);
            const total = amount + fee;

            await token18
                .connect(payer)
                .approve(
                    await token18Payment.getAddress(),
                    total
                );

            const recipientBefore =
                await token18.balanceOf(recipient.address);

            const commissionBefore =
                await token18.balanceOf(commissionWallet.address);

            await token18Payment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount
                );

            const recipientAfter =
                await token18.balanceOf(recipient.address);

            const commissionAfter =
                await token18.balanceOf(commissionWallet.address);

            expect(
                recipientAfter - recipientBefore
            ).to.equal(amount);

            expect(
                commissionAfter - commissionBefore
            ).to.equal(fee);

            expect(
                await token18.balanceOf(
                    await token18Payment.getAddress()
                )
            ).to.equal(0n);
        });

        it("Should calculate exact 0.35 percent fee with 18 decimals", async function () {
            const amount = ethers.parseUnits("1000", 18);

            expect(
                await token18Payment.calculateFee(amount)
            ).to.equal(
                ethers.parseUnits("3.5", 18)
            );
        });
    });

    describe("Atomicity", function () {
        it("Should revert entire ERC20 payment if fee transfer cannot complete", async function () {
            const amount = ethers.parseUnits("100", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total - 1n
                );

            const payerBefore =
                await token6.balanceOf(payer.address);

            const recipientBefore =
                await token6.balanceOf(recipient.address);

            const commissionBefore =
                await token6.balanceOf(commissionWallet.address);

            await expect(
                token6Payment
                    .connect(payer)
                    .pay(
                        recipient.address,
                        amount
                    )
            ).to.be.reverted;

            expect(
                await token6.balanceOf(payer.address)
            ).to.equal(payerBefore);

            expect(
                await token6.balanceOf(recipient.address)
            ).to.equal(recipientBefore);

            expect(
                await token6.balanceOf(commissionWallet.address)
            ).to.equal(commissionBefore);
        });

        it("Should leave no native funds in the contract after successful payment", async function () {
            const amount = ethers.parseEther("1");
            const fee = await nativePayment.calculateFee(amount);

            await nativePayment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount,
                    { value: amount + fee }
                );

            expect(
                await ethers.provider.getBalance(
                    await nativePayment.getAddress()
                )
            ).to.equal(0n);
        });

        it("Should leave no ERC20 funds in the contract after successful payment", async function () {
            const amount = ethers.parseUnits("100", 6);
            const fee = await token6Payment.calculateFee(amount);
            const total = amount + fee;

            await token6
                .connect(payer)
                .approve(
                    await token6Payment.getAddress(),
                    total
                );

            await token6Payment
                .connect(payer)
                .pay(
                    recipient.address,
                    amount
                );

            expect(
                await token6.balanceOf(
                    await token6Payment.getAddress()
                )
            ).to.equal(0n);
        });
    });
});