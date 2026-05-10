// Package zettapay is the official Go SDK for the ZettaPay Solana payment
// protocol. It provides a typed client over the merchant + X-402 payments
// HTTP API exposed by the ZettaPay backend.
//
// Quick start:
//
//	client, err := zettapay.NewClient(zettapay.ClientConfig{
//	    BaseURL: "https://api.zettapay.dev",
//	})
//	if err != nil {
//	    log.Fatal(err)
//	}
//
//	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
//	defer cancel()
//
//	merchant, err := client.RegisterMerchant(ctx, zettapay.RegisterMerchantInput{
//	    Name:         "Acme Coffee",
//	    WalletPubkey: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT",
//	    UsdcATA:      "EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK",
//	})
//
// Every method accepts a context.Context for cancellation and deadlines, and
// the client retries idempotent requests on transient failures using
// exponential backoff with full jitter.
package zettapay
