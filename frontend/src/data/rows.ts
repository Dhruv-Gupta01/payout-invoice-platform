import type { InvoiceStatus } from "@/components/ops/StatusBadge";

export type PayoutRow = {
  row: number;
  name: string;
  email: string;
  project: string;
  batch: number;
  role: "Annotator" | "QCer";
  hours: number;
  rate: number;
  status: InvoiceStatus;
};

const seed: Array<[string, string, PayoutRow["role"], number, InvoiceStatus]> = [
  ["Ritika Garg", "ritika.garg", "Annotator", 32, "Approved"],
  ["Dharna Kavya", "dharna.kavya", "QCer", 41, "Pending"],
  ["Aarav Menon", "aarav.menon", "Annotator", 24, "Not Generated"],
  ["Sneha Iyer", "sneha.iyer", "Annotator", 45, "Approved"],
  ["Kabir Ahluwalia", "kabir.ahluwalia", "QCer", 19, "Declined"],
  ["Meera Nair", "meera.nair", "Annotator", 37, "Pending"],
  ["Rohan Deshpande", "rohan.deshpande", "Annotator", 28, "Not Generated"],
  ["Ananya Bose", "ananya.bose", "QCer", 33, "Approved"],
  ["Vikram Sethi", "vikram.sethi", "Annotator", 17, "Pending"],
  ["Pooja Rawat", "pooja.rawat", "Annotator", 40, "Not Generated"],
  ["Imran Qureshi", "imran.qureshi", "QCer", 22, "Approved"],
  ["Nisha Pillai", "nisha.pillai", "Annotator", 35, "Pending"],
  ["Tanvi Shukla", "tanvi.shukla", "Annotator", 44, "Not Generated"],
  ["Arjun Kulkarni", "arjun.kulkarni", "QCer", 26, "Declined"],
];

export const payoutRows: PayoutRow[] = seed.map(([name, handle, role, hours, status], i) => ({
  row: i + 1,
  name,
  email: `${handle}@workmail.com`,
  project: "PDF",
  batch: 1,
  role,
  hours,
  rate: 100,
  status,
}));

export const inr = (n: number) =>
  "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });