/**
 * "Pourquoi l'oracle ne peut pas mentir": sign two outcomes with one throwaway key and one nonce,
 * then recover the key from the two signatures. Nothing here touches the real oracle keys.
 */
import {
  attest,
  generateNonce,
  generateSecretKey,
  getPublicKey,
  normalizeSecret,
  recoverKey,
} from '@ndox/oracle';

export interface EquivocationDemo {
  secret: string;
  pubkey: string;
  noncePoint: string;
  sigCalm: string;
  sigDanger: string;
  recovered: string;
}

export function runEquivocationDemo(): EquivocationDemo {
  // BIP340 keys are used in their even-Y form; show that form so it can be compared
  const secret = normalizeSecret(generateSecretKey()).toString(16).padStart(64, '0');
  const pubkey = getPublicKey(secret);
  const nonce = generateNonce();
  const calm = attest(secret, nonce.k, 'calme');
  const danger = attest(secret, nonce.k, 'danger');
  return {
    secret,
    pubkey,
    noncePoint: nonce.noncePoint,
    sigCalm: calm.noncePoint + calm.s,
    sigDanger: danger.noncePoint + danger.s,
    recovered: recoverKey(pubkey, calm, danger),
  };
}
