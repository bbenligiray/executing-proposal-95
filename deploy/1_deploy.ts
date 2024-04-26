import { artifacts, deployments, ethers } from 'hardhat';
import type { GnosisSafe } from '../typechain-types/GnosisSafe';
import type { Migration } from '../typechain-types/@gnosis.pm/safe-contracts/contracts/examples/libraries/Migrate_1_3_0_to_1_2_0.sol';
enum Operation {
  Call,
  DelegateCall,
}

const SAFE_ADDRESS = '0xA742E1d181c59C9C4dD5687172eFC119E3868D09';
const NEW_SAFE_ADDRESS = '0x8e03609ed680B237C7b6f8020472CA0687308b24';
const SECONDARY_VOTING_APP = '0x1c8058E72E4902B3431Ef057E8d9a58A73F26372';
const PROPOSAL_ID = 95;

module.exports = async () => {
  const { deploy, log } = deployments;
  const [deployer, fakeOwner1, fakeOwner2, fakeOwner3] = await ethers.getSigners();
  const fakeOwnersWithAscendingAddresses = [fakeOwner1, fakeOwner2, fakeOwner3].sort((a, b) =>
    BigInt(a!.address) > BigInt(b!.address) ? 1 : -1
  );

  // Get our Safe contract
  const { abi: safeAbi } = await artifacts.readArtifact('GnosisSafe');
  const safe = new ethers.Contract(SAFE_ADDRESS, safeAbi, deployer) as unknown as GnosisSafe;

  // Add three fake owners to the Safe contract
  await deployer!.sendTransaction({ to: safe.getAddress(), value: ethers.parseEther('1') });
  const impersonatedSafe = await ethers.getImpersonatedSigner(await safe.getAddress());
  const originalThreshold = await safe.getThreshold();
  for (const fakeOwner of fakeOwnersWithAscendingAddresses) {
    await safe.connect(impersonatedSafe).addOwnerWithThreshold(fakeOwner!.address, originalThreshold);
  }

  // Deploy the new singleton that we will upgrade to
  const forwarder = await deployments.get('Forwarder').catch(async () => {
    log(`Deploying Forwarder`);
    return deploy('Forwarder', {
      from: deployer!.address,
      args: [NEW_SAFE_ADDRESS],
    });
  });

  // Deploy the migration contract that the Safe will delegatecall to execute the upgrade
  const { address: migrationAddress, abi: migrationAbi } = await deployments.get('Migration').catch(async () => {
    log(`Deploying Migration`);
    return deploy('Migration', {
      from: deployer!.address,
      args: [forwarder.address],
    });
  });
  const migration = new ethers.Contract(migrationAddress, migrationAbi, deployer) as unknown as Migration;

  // Prepare signatures
  // Refer to https://github.com/api3dao/manager-multisig/blob/main/frontend/src/multisig/sign.ts
  const DOMAIN_SEPARATOR_TYPEHASH = '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218';
  const chainId = '31337'; // !
  const domainSeperator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address'],
      [DOMAIN_SEPARATOR_TYPEHASH, chainId, await safe.getAddress()]
    )
  );
  const SAFE_TX_TYPEHASH = '0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8';
  const safeTxHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'bytes32',
        'address',
        'uint256',
        'bytes32',
        'uint256',
        'uint256',
        'uint256',
        'uint256',
        'address',
        'address',
        'uint256',
      ],
      [
        SAFE_TX_TYPEHASH,
        await migration.getAddress(),
        0,
        ethers.keccak256(migration.interface.encodeFunctionData('migrate')),
        Operation.DelegateCall,
        0,
        0,
        0,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        await safe.nonce(),
      ]
    )
  );
  const hash = ethers.keccak256(
    ethers.solidityPacked(['bytes1', 'bytes1', 'bytes32', 'bytes32'], ['0x19', '0x01', domainSeperator, safeTxHash])
  );
  const signaturesWithAscendingAddresses = [] as any;
  for (const fakeOwner of fakeOwnersWithAscendingAddresses) {
    const signature = await fakeOwner!.signMessage(ethers.toBeArray(hash));
    const v = parseInt(signature.slice(-2), 16);
    let updatedV;
    // We need to add 4 to v because that's what GnosisSafe.sol expects
    // https://docs.gnosis-safe.io/contracts/signatures#eth_sign-signature
    if (v === 0 || v === 1) {
      // Ledger subtracts 27 from v, undo that
      // https://github.com/LedgerHQ/ledgerjs/issues/466
      updatedV = v + 27 + 4;
    } else if (v === 27 || v === 28) {
      updatedV = v + 4;
    } else {
      throw new Error(`Unexpected v in signature: ${v}`);
    }
    signaturesWithAscendingAddresses.push(signature.slice(0, -2) + updatedV.toString(16).padStart(2, '0'));
  }

  // Execute tx
  // Refer to https://github.com/api3dao/manager-multisig/blob/main/frontend/src/multisig/execute.ts
  const encodedSignatures = ethers.solidityPacked(
    Array(signaturesWithAscendingAddresses.length).fill('bytes'),
    signaturesWithAscendingAddresses
  );

  await safe.execTransaction(
    migration.getAddress(),
    0,
    migration.interface.encodeFunctionData('migrate'),
    Operation.DelegateCall,
    0,
    0,
    0,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    encodedSignatures
  );

  // Execute the proposal
  console.log(`New Safe balance before proposal execution: ${await ethers.provider.getBalance(NEW_SAFE_ADDRESS)}`);
  const secondaryVotingApp = new ethers.Contract(SECONDARY_VOTING_APP, ['function executeVote(uint256 _voteId)'], deployer) as any;
  await secondaryVotingApp.executeVote(PROPOSAL_ID);
  console.log(`New Safe balance after proposal execution: ${await ethers.provider.getBalance(NEW_SAFE_ADDRESS)}`);
};
