// Scheduled commercial banks operating in India (public sector, private
// sector, small finance banks, payments banks, and the more common foreign
// banks). Not exhaustive of every regional rural / urban co-operative bank —
// BankNameCombobox always offers a manual "type it yourself" fallback for
// anything not on this list.
export const INDIAN_BANKS: string[] = [
  // Public sector banks
  "Bank of Baroda",
  "Bank of India",
  "Bank of Maharashtra",
  "Canara Bank",
  "Central Bank of India",
  "Indian Bank",
  "Indian Overseas Bank",
  "Punjab & Sind Bank",
  "Punjab National Bank",
  "State Bank of India",
  "UCO Bank",
  "Union Bank of India",

  // Private sector banks
  "Axis Bank",
  "Bandhan Bank",
  "City Union Bank",
  "CSB Bank",
  "DCB Bank",
  "Dhanlaxmi Bank",
  "Federal Bank",
  "HDFC Bank",
  "ICICI Bank",
  "IDBI Bank",
  "IDFC FIRST Bank",
  "IndusInd Bank",
  "Jammu & Kashmir Bank",
  "Karnataka Bank",
  "Karur Vysya Bank",
  "Kotak Mahindra Bank",
  "Nainital Bank",
  "RBL Bank",
  "South Indian Bank",
  "Tamilnad Mercantile Bank",
  "YES Bank",

  // Small finance banks
  "AU Small Finance Bank",
  "Capital Small Finance Bank",
  "Equitas Small Finance Bank",
  "ESAF Small Finance Bank",
  "Jana Small Finance Bank",
  "North East Small Finance Bank",
  "Shivalik Small Finance Bank",
  "Suryoday Small Finance Bank",
  "Ujjivan Small Finance Bank",
  "Unity Small Finance Bank",
  "Utkarsh Small Finance Bank",

  // Payments banks
  "Airtel Payments Bank",
  "Fino Payments Bank",
  "India Post Payments Bank",
  "Jio Payments Bank",
  "NSDL Payments Bank",
  "Paytm Payments Bank",

  // Foreign banks with a retail/corporate presence in India
  "American Express Banking Corp",
  "Bank of America",
  "Barclays Bank",
  "Citibank",
  "CTBC Bank",
  "DBS Bank India",
  "Deutsche Bank",
  "HSBC",
  "JPMorgan Chase Bank",
  "Standard Chartered Bank",
  "Sumitomo Mitsui Banking Corporation",

  // Well-known co-operative banks
  "Cosmos Co-operative Bank",
  "Saraswat Co-operative Bank",
  "Shamrao Vithal Co-operative Bank (SVC)",
  "The Mumbai District Central Co-operative Bank",
].sort((a, b) => a.localeCompare(b));
