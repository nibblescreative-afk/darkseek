use anchor_lang::prelude::*;

/// Custom errors are reported as 6000 + their position in this list.
#[error_code]
pub enum VaultError {
    #[msg("Only the DarkSeek admin may do this")]
    NotAdmin,
    #[msg("Bad parameters")]
    BadParams,
    #[msg("Bad amount")]
    BadAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("This vault has no active session for the game server")]
    NoSession,
    #[msg("Daily cap of the game session reached")]
    OverDailyCap,
    #[msg("Not enough in the vault")]
    InsufficientFunds,
    #[msg("Wrong round for this room")]
    WrongRound,
    #[msg("A round is running in this room")]
    RoundRunning,
    #[msg("No such seat")]
    BadSlot,
    #[msg("That seat is taken")]
    SeatTaken,
    #[msg("This wallet already has a seat in the room")]
    AlreadySeated,
    #[msg("A round starts only when all ten seats are staked")]
    RoomNotFull,
    #[msg("A seated player's vault is missing or wrong")]
    MissingVault,
    #[msg("Bad round outcome")]
    BadOutcome,
    #[msg("The round is not old enough to unwind")]
    NotStale,
    #[msg("Only the proposed admin may accept")]
    NotPendingAdmin,
    #[msg("The $DS mint is not recorded yet")]
    DsNotReady,
    #[msg("The $DS mint is already recorded")]
    DsAlreadySet,
    #[msg("$DS must have a fixed supply: no mint or freeze authority")]
    DsNotFixed,
    #[msg("The auction would take less than its minimum fill")]
    BelowMinFill,
    #[msg("The auction price moved past your limit")]
    PriceMoved,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("This mint has an extension that could take, freeze, tax or block tokens")]
    MintExtensionNotAllowed,
}
