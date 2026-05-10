package zettapay

// Merchant is a registered ZettaPay merchant returned by the API.
type Merchant struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	WalletPubkey string `json:"walletPubkey"`
	UsdcATA      string `json:"usdcAta"`
	CreatedAt    int64  `json:"createdAt"`
}

// RegisterMerchantInput is the body of a RegisterMerchant call.
type RegisterMerchantInput struct {
	Name         string `json:"name"`
	WalletPubkey string `json:"wallet_pubkey"`
	UsdcATA      string `json:"usdc_ata"`
}

// UpdateMerchantInput patches a merchant. Empty string fields are omitted from
// the request body so the API treats them as "not provided".
type UpdateMerchantInput struct {
	Name         string `json:"name,omitempty"`
	WalletPubkey string `json:"wallet_pubkey,omitempty"`
	UsdcATA      string `json:"usdc_ata,omitempty"`
}

// ListOptions controls pagination on list endpoints.
type ListOptions struct {
	Limit  int
	Offset int
}

// ListMerchantsResponse is the envelope returned by ListMerchants.
type ListMerchantsResponse struct {
	Items []Merchant `json:"items"`
	Count int        `json:"count"`
}

// PaymentRecord is a payment recovered from the ledger.
type PaymentRecord struct {
	ID               string   `json:"id"`
	FeePayer         string   `json:"feePayer"`
	Signers          []string `json:"signers"`
	Signatures       []string `json:"signatures"`
	RecentBlockhash  string   `json:"recentBlockhash"`
	IsVersioned      bool     `json:"isVersioned"`
	Version          *int     `json:"version"`
	TransactionBytes int      `json:"transactionBytes"`
	AcceptedAt       int64    `json:"acceptedAt"`
}

// PayResponse is the receipt returned by Pay.
type PayResponse struct {
	Accepted         bool   `json:"accepted"`
	PaymentID        string `json:"paymentId"`
	FeePayer         string `json:"feePayer"`
	Signers          []string `json:"signers"`
	SignatureCount   int    `json:"signatureCount"`
	RecentBlockhash  string `json:"recentBlockhash"`
	IsVersioned      bool   `json:"isVersioned"`
	Version          *int   `json:"version"`
	TransactionBytes int    `json:"transactionBytes"`
}

// ListPaymentsResponse is the envelope returned by ListPayments.
type ListPaymentsResponse struct {
	Items []PaymentRecord `json:"items"`
	Count int             `json:"count"`
	Total int             `json:"total"`
}

// HealthStatus is the response of the /healthz probe.
type HealthStatus struct {
	Status    string `json:"status"`
	Merchants int    `json:"merchants"`
	Payments  int    `json:"payments"`
}

// apiErrorEnvelope mirrors the JSON shape returned by the API on errors.
type apiErrorEnvelope struct {
	Error apiErrorBody `json:"error"`
}

type apiErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}
