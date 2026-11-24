// Pure keyword floor for sensitive domains. The model also labels answers; code takes the stricter of the two,
// so a health, money or legal answer can't lose its "general information" label because the model missed it.
import type { Domain } from "./categories";

const RULES: [Exclude<Domain, "none">, RegExp][] = [
  ["health", /\b(medic\w*|medicine|dose|dosage|mg\b|pill|tablet|vitamin|supplement|symptom\w*|pain|fever|doctor|dentist|vaccin\w*|tetanus|booster|allerg\w*|diagnos\w*|prescri\w*|antibiotic\w*|ibuprofen|paracetamol|acetaminophen|blood pressure|cholesterol|diet|pregnan\w*|mental health|anxiety|depress\w*|therap\w*|injur\w*|rash|infection|sick|ill(ness)?)\b/i],
  ["finance", /\b(money|loan|lend|lent|borrow\w*|debt|owe[sd]?|credit|mortgage|tax(es)?|invest\w*|stock market|stocks|crypto\w*|bitcoin|savings?|budget\w*|retire\w*|pension|interest rate|insurance|refund|bank\w*|salary)\b/i],
  ["legal", /\b(legal\w*|law(yer|suit)?s?|attorney|court|sue|contract\w*|lease|landlord|tenant|(?:my|consumer|legal) rights|liabilit\w*|warranty claim|small claims|police|speeding fine|visa|immigration|custody|divorce|will and testament|copyright|gdpr|nda)\b/i],
];

export function classifyDomain(text: string): Domain {
  for (const [d, re] of RULES) if (re.test(text)) return d;
  return "none";
}

const RANK: Record<Domain, number> = { none: 0, legal: 1, finance: 2, health: 3 };

/** The stricter label wins (health > finance > legal > none). */
export function stricterDomain(a: Domain, b: Domain): Domain {
  return RANK[a] >= RANK[b] ? a : b;
}
