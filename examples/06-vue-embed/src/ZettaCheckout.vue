<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{
  merchantId: string;
  amount: string;
  currency?: string;
  reference?: string;
}>();
const emit = defineEmits<{ settled: [{ intentId: string; signature: string }] }>();

const el = ref<HTMLElement | null>(null);

function onSettled(event: Event) {
  emit("settled", (event as CustomEvent).detail);
}

onMounted(() => el.value?.addEventListener("zettapay:settled", onSettled));
onBeforeUnmount(() => el.value?.removeEventListener("zettapay:settled", onSettled));
</script>

<template>
  <zetta-checkout
    ref="el"
    :data-merchant-id="props.merchantId"
    :data-amount="props.amount"
    :data-currency="props.currency ?? 'USD'"
    :data-reference="props.reference"
  />
</template>
