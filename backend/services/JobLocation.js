// Where a job is, relative to an India-based student. Postings carry free-text
// locations ("Bengaluru, Karnataka", "Remote - US", "London | Pune"), so this is
// a keyword match — good enough to rank India roles first.

const INDIA = /\b(india|bengaluru|bangalore|pune|mumbai|hyderabad|gurgaon|gurugram|delhi|noida|chennai|kolkata|ahmedabad|jaipur|kochi|chandigarh|indore|coimbatore|thiruvananthapuram|trivandrum|bhubaneswar|nagpur|lucknow|vadodara|surat|mysuru|mysore|nashik)\b/i;

// "Remote - US" is remote for people in the US, not for us.
const NON_INDIA_REGION = /\b(us|usa|u\.s\.a?\.?|united states|canada|uk|united kingdom|europe|emea|eu|germany|france|spain|ireland|netherlands|australia|latam|mexico|brazil|japan|singapore)\b/i;

export const isIndiaLocation = (location = '') => INDIA.test(String(location));

// How realistic a job's location is for an India-based student: India is a
// full fit; a remote role might be open to India (or might be US-only); a
// role abroad usually needs relocation or a visa.
export function locationFit(location = '') {
  if (isIndiaLocation(location)) return { fit: 'india', weight: 1 };
  if (/remote/i.test(location) && !NON_INDIA_REGION.test(location)) return { fit: 'remote', weight: 0.9 };
  return { fit: 'abroad', weight: 0.8 };
}
