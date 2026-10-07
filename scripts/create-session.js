// Dev helper: create a verification session the way the loan system would, and print the customer link.
// Usage: npm run create-session -- [salaried|business|wfh]
const persona = process.argv[2] || 'salaried';
const base = process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 8080}`;

const res = await fetch(`${base}/api/internal/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': process.env.INTERNAL_API_KEY || '' },
  body: JSON.stringify({
    loanId: `TEST-${Date.now()}`,
    applicantName: 'Ramesh Kumar Sharma',
    businessName: persona === 'business' ? 'Sharma General Stores' : undefined,
    line1: 'Flat 402, Shanti Apartments',
    area: 'Andheri East',
    city: 'Mumbai',
    pincode: '400069',
    persona,
    lang: 'en',
  }),
});
const body = await res.json();
if (!res.ok) {
  console.error(res.status, body);
  process.exit(1);
}
console.log(body);
