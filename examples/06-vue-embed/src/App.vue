<script setup lang="ts">
import { ref } from "vue";
import ZettaCheckout from "./ZettaCheckout.vue";

const merchantId = import.meta.env.VITE_ZETTAPAY_MERCHANT_ID as string;
const settled = ref<{ intentId: string; signature: string } | null>(null);
</script>

<template>
  <main style="font-family: system-ui; padding: 32px; max-width: 640px">
    <h1>Buy this cool thing (Vue)</h1>
    <p>One cool thing — 12 USDC.</p>
    <ZettaCheckout
      :merchant-id="merchantId"
      amount="12.00"
      :reference="`vue-demo-${Date.now()}`"
      @settled="settled = $event"
    />
    <p v-if="settled" style="color: green">
      Paid · <code>{{ settled.signature.slice(0, 16) }}…</code>
    </p>
  </main>
</template>
