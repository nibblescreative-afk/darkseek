//! Accounts of every instruction, with the checks Anchor runs before the handler.

//!
//! USDC is a classic SPL token (`anchor_spl::token`). $DS and vested tokens go
//! through `anchor_spl::token_interface`, so they may belong to SPL Token or to
//! Token 2022.

use crate::error::VaultError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::token_interface as ti;

// ---------------------------------------------------------------------- admin

#[derive(Accounts)]
pub struct Initialize<'info> {
    /// must be the program's upgrade authority
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(init, payer = admin, seeds = [b"custody"], bump, token::mint = mint, token::authority = config, token::token_program = token_program)]
    pub custody: Account<'info, TokenAccount>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ VaultError::NotAdmin)]
    pub program: Program<'info, crate::program::DarkseekVault>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ VaultError::NotAdmin)]
    pub program_data: Account<'info, ProgramData>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ VaultError::NotAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = pending_admin @ VaultError::NotPendingAdmin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
#[instruction(index: u8)]
pub struct InitRoom<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin @ VaultError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Room::INIT_SPACE, seeds = [b"room".as_ref(), &[index]], bump)]
    pub room: Account<'info, Room>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitDs<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ VaultError::NotAdmin)]
    pub config: Account<'info, Config>,
    #[account(mint::token_program = ds_token_program)]
    pub ds_mint: InterfaceAccount<'info, ti::Mint>,
    #[account(init, payer = admin, seeds = [b"ds_custody"], bump, token::mint = ds_mint, token::authority = config, token::token_program = ds_token_program)]
    pub ds_custody: InterfaceAccount<'info, ti::TokenAccount>,
    pub ds_token_program: Interface<'info, ti::TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SweepTreasury<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ VaultError::NotAdmin, has_one = mint, has_one = custody)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub custody: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub to: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------- players

#[derive(Accounts)]
pub struct OpenVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: any wallet; the vault is created for it and it does not need to sign
    pub owner: UncheckedAccount<'info>,
    #[account(init, payer = payer, space = 8 + Vault::INIT_SPACE, seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

/// The vault owner acting on their own vault.
#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint, has_one = custody)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub custody: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = depositor)]
    pub from: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = mint, has_one = custody)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub custody: Account<'info, TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub to: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    pub token_program: Program<'info, Token>,
}

/// The owner pays the protocol from their vault (shop).
#[derive(Accounts)]
pub struct Charge<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

/// The owner pays another player's vault (P2P).
#[derive(Accounts)]
pub struct Pay<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = from.bump, constraint = from.owner == owner.key() @ VaultError::MissingVault)]
    pub from: Account<'info, Vault>,
    #[account(mut, seeds = [b"vault", to.owner.as_ref()], bump = to.bump)]
    pub to: Account<'info, Vault>,
}

// ---------------------------------------------------------------------- rooms (game server)

#[derive(Accounts)]
pub struct LockStake<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"room".as_ref(), &[room.index]], bump = room.bump)]
    pub room: Account<'info, Room>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct RoomOp<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"room".as_ref(), &[room.index]], bump = room.bump)]
    pub room: Account<'info, Room>,
}

#[derive(Accounts)]
pub struct AbortStale<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"room".as_ref(), &[room.index]], bump = room.bump)]
    pub room: Account<'info, Room>,
}

// ---------------------------------------------------------------------- $DS

#[derive(Accounts)]
pub struct DepositDs<'info> {
    pub depositor: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = ds_mint, has_one = ds_custody, has_one = ds_token_program)]
    pub config: Account<'info, Config>,
    pub ds_mint: InterfaceAccount<'info, ti::Mint>,
    #[account(mut)]
    pub ds_custody: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, token::mint = ds_mint, token::authority = depositor, token::token_program = ds_token_program)]
    pub from: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    pub ds_token_program: Interface<'info, ti::TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawDs<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = ds_mint, has_one = ds_custody, has_one = ds_token_program)]
    pub config: Account<'info, Config>,
    pub ds_mint: InterfaceAccount<'info, ti::Mint>,
    #[account(mut)]
    pub ds_custody: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, token::mint = ds_mint, token::token_program = ds_token_program)]
    pub to: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
    pub ds_token_program: Interface<'info, ti::TokenInterface>,
}

/// Staking changes: the owner signs; the config's totals and accumulator move with it.
#[derive(Accounts)]
pub struct StakeDs<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump = vault.bump, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

/// Anyone may claim a vault's staking rewards or turn its rebate credit into
/// $DS: either way the value can only go into that vault.
#[derive(Accounts)]
pub struct ClaimForVault<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"vault", vault.owner.as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

/// One fill of the $DS auction. Anyone may sell; the seller signs for their $DS.
#[derive(Accounts)]
pub struct SellDs<'info> {
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = mint, has_one = custody, has_one = ds_mint, has_one = ds_custody, has_one = ds_token_program)]
    pub config: Account<'info, Config>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub custody: Account<'info, TokenAccount>,
    /// burning lowers the supply recorded in the mint
    #[account(mut)]
    pub ds_mint: InterfaceAccount<'info, ti::Mint>,
    #[account(mut)]
    pub ds_custody: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, token::mint = ds_mint, token::authority = seller, token::token_program = ds_token_program)]
    pub seller_ds: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, token::mint = mint)]
    pub seller_usdc: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub ds_token_program: Interface<'info, ti::TokenInterface>,
}

// ---------------------------------------------------------------------- vesting

#[derive(Accounts)]
#[instruction(id: u64)]
pub struct CreateVesting<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,
    /// CHECK: any wallet; it does not need to sign to receive a schedule
    pub beneficiary: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, ti::Mint>,
    #[account(init, payer = funder, space = 8 + Vesting::INIT_SPACE,
        seeds = [b"vesting", mint.key().as_ref(), beneficiary.key().as_ref(), &id.to_le_bytes()], bump)]
    pub vesting: Account<'info, Vesting>,
    #[account(init, payer = funder, seeds = [b"vesting_tokens", vesting.key().as_ref()], bump,
        token::mint = mint, token::authority = vesting, token::token_program = token_program)]
    pub vesting_tokens: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = funder, token::token_program = token_program)]
    pub from: InterfaceAccount<'info, ti::TokenAccount>,
    pub token_program: Interface<'info, ti::TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Anyone may release what has vested: it can only go to the beneficiary.
#[derive(Accounts)]
pub struct ClaimVesting<'info> {
    #[account(mut, seeds = [b"vesting", mint.key().as_ref(), vesting.beneficiary.as_ref(), &vesting.id.to_le_bytes()], bump = vesting.bump, has_one = mint)]
    pub vesting: Account<'info, Vesting>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, ti::Mint>,
    #[account(mut, seeds = [b"vesting_tokens", vesting.key().as_ref()], bump)]
    pub vesting_tokens: InterfaceAccount<'info, ti::TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = vesting.beneficiary, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, ti::TokenAccount>,
    pub token_program: Interface<'info, ti::TokenInterface>,
}
