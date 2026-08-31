export type Resource = {
  id: string;
  name: string;
  email: string;
  role: "Annotator" | "QCer";
  pending: number;
  approved: number;
  declined: number;
  docsPending: boolean;
};

const seed: Array<[string, string, Resource["role"], number, number, number, boolean]> = [
  ["Ritika Garg", "ritika.garg", "Annotator", 1, 6, 0, true],
  ["Dharna Kavya", "dharna.kavya", "QCer", 2, 4, 1, false],
  ["Surendra Sai", "surendra.sai", "Annotator", 0, 9, 2, true],
  ["Sneha Iyer", "sneha.iyer", "Annotator", 3, 2, 0, false],
  ["Kabir Ahluwalia", "kabir.ahluwalia", "QCer", 1, 1, 3, true],
  ["Meera Nair", "meera.nair", "Annotator", 2, 7, 0, false],
  ["Rohan Deshpande", "rohan.deshpande", "Annotator", 0, 3, 1, true],
  ["Ananya Bose", "ananya.bose", "QCer", 4, 5, 0, false],
];

export const resources: Resource[] = seed.map(
  ([name, handle, role, pending, approved, declined, docsPending]) => ({
    id: handle.replace(".", "-"),
    name,
    email: `${handle}@workmail.com`,
    role,
    pending,
    approved,
    declined,
    docsPending,
  }),
);

export const totalInvoices = (r: Resource) => r.pending + r.approved + r.declined;


export type ResourceProfile = {
  address: string;
  contact: string;
  pan: string;
  beneficiary: string;
  account: string;
  bank: string;
  ifsc: string;
};

export type ResourceInvoice = {
  id: string;
  project: string;
  batch: number;
  amount: number;
  status: "Pending" | "Approved" | "Declined";
  actionedAt?: string;
  declineReason?: string;
};

const banks = ["HDFC Bank", "ICICI Bank", "Axis Bank", "State Bank of India", "Kotak Mahindra Bank"];
const cities = ["Bengaluru", "Pune", "Hyderabad", "Jaipur", "Kochi", "Indore", "Nagpur", "Lucknow"];

export function profileFor(r: Resource): ResourceProfile {
  const i = resources.findIndex((x) => x.id === r.id);
  const seq = String(i + 1).padStart(2, "0");
  return {
    address: `${12 + i}, Sector ${3 + i}, ${cities[i % cities.length]} ${560001 + i * 137}`,
    contact: `+91 9${8 - (i % 3)}${seq}0 ${34210 + i}`,
    pan: `ABCPG${1234 + i}${String.fromCharCode(65 + (i % 26))}`,
    beneficiary: r.name,
    account: `5011${seq}00${7842910 + i * 13}`,
    bank: banks[i % banks.length]!,
    ifsc: `HDFC000${2100 + i}`,
  };
}

export function invoicesFor(r: Resource): ResourceInvoice[] {
  const i = resources.findIndex((x) => x.id === r.id);
  const base: ResourceInvoice[] = [
    { id: "1", project: "PDF", batch: 1, amount: 3200, status: "Approved", actionedAt: "2026-07-28T10:15:00.000Z" },
    { id: "2", project: "PDF", batch: 2, amount: 4100, status: "Approved", actionedAt: "2026-08-05T09:30:00.000Z" },
    { id: "3", project: "PDF", batch: 3, amount: 2400 + i * 100, status: "Pending" },
    {
      id: "4",
      project: "PDF",
      batch: 4,
      amount: 1900,
      status: "Declined",
      actionedAt: "2026-08-12T16:45:00.000Z",
      declineReason: "Hours logged don't match the batch tracker",
    },
    { id: "5", project: "PDF", batch: 5, amount: 3700 + i * 50, status: "Pending" },
  ];
  return base.map((b) => ({ ...b, id: `${r.id}-${b.id}` }));
}

const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function formatActionDate(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const h24 = d.getUTCHours();
  const ampm = h24 >= 12 ? "PM" : "AM";
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h}:${mm} ${ampm}`;
}
