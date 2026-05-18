export class MerchantNotInitializedError extends Error {
  constructor(dataDir: string) {
    super(
      `@zettapay/listener: merchant.json not found at ${dataDir}. ` +
        `Run "zettapay-listener init" first.`,
    );
    this.name = 'MerchantNotInitializedError';
  }
}

export class InvoiceNotFoundError extends Error {
  readonly invoiceId: string;
  constructor(invoiceId: string) {
    super(`@zettapay/listener: invoice "${invoiceId}" not found.`);
    this.name = 'InvoiceNotFoundError';
    this.invoiceId = invoiceId;
  }
}

export class WebhookEventNotFoundError extends Error {
  readonly eventId: string;
  constructor(eventId: string) {
    super(`@zettapay/listener: webhook event "${eventId}" not found.`);
    this.name = 'WebhookEventNotFoundError';
    this.eventId = eventId;
  }
}

export class StorageCorruptionError extends Error {
  readonly filePath: string;
  override readonly cause?: unknown;
  constructor(filePath: string, cause?: unknown) {
    super(`@zettapay/listener: storage file is corrupted: ${filePath}`);
    this.name = 'StorageCorruptionError';
    this.filePath = filePath;
    this.cause = cause;
  }
}
