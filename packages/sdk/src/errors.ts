// The program's custom errors (6000 + position, as in programs/darkseek-vault/src/error.rs).

export const VAULT_ERRORS = [
  'NotAdmin',
  'BadParams',
  'BadAmount',
  'Overflow',
  'NoSession',
  'OverDailyCap',
  'InsufficientFunds',
  'WrongRound',
  'RoundRunning',
  'BadSlot',
  'SeatTaken',
  'AlreadySeated',
  'RoomNotFull',
  'MissingVault',
  'BadOutcome',
  'NotStale',
  'NotPendingAdmin',
  'DsNotReady',
  'DsAlreadySet',
  'DsNotFixed',
  'BelowMinFill',
  'PriceMoved',
  'NothingToClaim',
  'MintExtensionNotAllowed',
  'TooEarly',
  'DsSupply',
] as const;

export type VaultErrorName = (typeof VAULT_ERRORS)[number];

export const errorCode = (name: VaultErrorName): number => 6000 + VAULT_ERRORS.indexOf(name);

/** The vault error a failed transaction or simulation ended with, if any. */
export function vaultErrorOf(err: unknown): VaultErrorName | null {
  const e = err as { message?: string; logs?: string[]; transactionLogs?: string[] } | null;
  const text = `${String(e?.message ?? err)} ${JSON.stringify(e?.logs ?? e?.transactionLogs ?? '')}`;
  const named = /Error Code: (\w+)/.exec(text);
  if (named && (VAULT_ERRORS as readonly string[]).includes(named[1])) return named[1] as VaultErrorName;
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  const dec = /"Custom":\s*(\d+)/.exec(text);
  const code = hex ? parseInt(hex[1], 16) : dec ? Number(dec[1]) : NaN;
  return VAULT_ERRORS[code - 6000] ?? null;
}
