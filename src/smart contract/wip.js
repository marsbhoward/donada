import {
    Address, Role, Account, Party, ada, lovelace, AvailableMoney, Constant, ConstantParam,
    NegValue, AddValue, SubValue, MulValue, DivValue, ChoiceValue, TimeIntervalStart,
    TimeIntervalEnd, UseValue, Cond, AndObs, OrObs, NotObs, ChoseSomething,
    ValueGE, ValueGT, ValueLT, ValueLE, ValueEQ, TrueObs, FalseObs, Deposit,
    Choice, Notify, Close, Pay, If, When, Let, Assert, SomeNumber, AccountId,
    ChoiceId, Token, ValueId, Value, EValue, Observation, Bound, Action, Payee,
    Case, Timeout, ETimeout, TimeParam, Contract
} from 'marlowe-js';

(function (): Contract {


// Role Declarations
const nftOwner: Party = Role('nftOwner');  // NFT Owner
const nftRenter: Party = Role('nftRenter');  // NFT Renter
const nftCreator: Party = Role('nftCreator');  // Creator of the lottery or drawing event
const projectWallet: Party = Role('ProjectWallet');  // Wallet to hold the NFT

// NFT and Contract Details
const policyId = "project_policy_id";  // NFT Policy ID
const assetName = "nft_name";  // NFT Asset Name
const rentalPrice = 100;  // Example rental price from web form
const winnings = Constant(1000);  // Example winnings for illustration
const drawDate = 7 * 24 * 60 * 60;  // Draw date in seconds (adjustable)
const nftToken = Token(policyId, assetName);  // NFT as a token

// Step 1: nftOwner deposits the NFT into the project wallet
const depositNFT = Deposit(
  nftOwner, // The nftOwner deposits the NFT
  projectWallet, // Deposited into project wallet
  nftToken,1 // NFT token
);

// Step 2: nftRenter pays the rental fee if selected for rental
const payRentalFee = Pay(
  nftRenter, // The renter pays
  Account(nftOwner), // Rental fee goes to the nftOwner,
  Token("lovelace", ""),// Paid in ADA
  Constant(rentalPrice), // Rental fee price set by nftOwner,
  Close
);

// Step 3: Contract checks if the NFT is a winner based on an external contract or oracle

const checkIfWinner = Choice(
  "IsWinner", // Choice key to mark whether the NFT is a winner
  [nftRenter, nftOwner] // Choices made by these parties
);

// Step 4: Distribute winnings if the NFT is a winner and rented
const distributeWinningsRented = When(
  [
    // 10% of winnings go to the nftOwner
    Case(Pay(
      nftCreator, // Winnings come from the nftCreator account
      Account(nftOwner), // 10% to nftOwner
      Value.div(winnings, Constant(10)), // 10% of winnings
      Token("lovelace", "") // In ADA
    ), Close),
    // 90% of winnings go to the nftRenter
    Case(Pay(
      nftCreator, // Winnings come from the nftCreator account
      Account(nftRenter), // 90% to nftRenter
      Value.sub(winnings, Value.div(winnings, Constant(10))), // 90% of winnings
      Token("lovelace", "") // In ADA
    ), Close)
  ],
  Close
);

// Step 5: Distribute 100% of winnings to nftOwner if the NFT was not rented
const distributeWinningsNotRented = Pay(
  nftCreator, // Winnings come from nftCreator
  Account(nftOwner), // 100% of winnings go to nftOwner
  winnings, // Full winnings
  Token("lovelace", "") // Paid in ADA
);

// Step 6: Return the NFT to nftOwner at the draw date regardless of outcome
const returnNFT = Pay(
  projectWallet, // NFT held in project wallet
  Account(nftOwner), // Returned to nftOwner
  nftToken // The NFT token
);

// Contract logic for rental, winning check, and return
const contract = When(
  [
    // Step 1: nftOwner deposits NFT
    Case(depositNFT,
      When(
        [
          // Step 2: If selected, nftRenter pays rental fee
          Case(payRentalFee, 
            When(
              [
                // Step 3: Check if the NFT is a winner
                Case(checkIfWinner, 
                  If(
                    Value.eq(Choice.value("IsWinner"), Constant(1)), // If NFT is a winner
                    distributeWinningsRented, // Distribute winnings if rented
                    distributeWinningsNotRented // Distribute winnings if not rented
                  )
                )
              ],
              Close // Close contract if no winner or no further actions
            )
          )
        ],
        Close
      )
    )
  ],
  Close
);

// Return NFT after draw date and close the contract
const fullContract = When(
  [
    Case(returnNFT, Close)
  ],
  drawDate, // Return NFT on the draw date
  contract
);


})