<script setup lang="ts">
import { ref } from "vue";

const response = ref("尚未请求");
const isLoading = ref(false);

async function checkApi() {
  isLoading.value = true;

  try {
    const result = await fetch("/api/hello");
    if (!result.ok) {
      throw new Error(`请求失败 (${result.status})`);
    }

    response.value = await result.text();
  } catch (error) {
    response.value = error instanceof Error ? error.message : "请求失败";
  } finally {
    isLoading.value = false;
  }
}
</script>

<template>
  <div class="page-shell">
    <header class="topbar">
      <span class="brand">NeuralWatt</span>
      <span class="framework">Vue 3</span>
    </header>

    <main class="content">
      <p class="eyebrow">Application ready</p>
      <h1>Vue is connected.</h1>
      <p class="description">
        This page is rendered by a Vue single-file component and served through Vite and Nitro.
      </p>

      <section class="api-status" aria-live="polite">
        <div>
          <span class="label">API status</span>
          <output>{{ response }}</output>
        </div>
        <button type="button" :disabled="isLoading" @click="checkApi">
          {{ isLoading ? "Checking..." : "Check API" }}
        </button>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page-shell {
  min-height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 1024px;
  margin: 0 auto;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid #dce3ef;
}

.brand {
  font-size: 1.1rem;
  font-weight: 700;
}

.framework {
  color: #526078;
  font-size: 0.875rem;
}

.content {
  max-width: 760px;
  margin: 0 auto;
  padding: 7rem 1.5rem;
}

.eyebrow,
.label {
  color: #2563eb;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  margin: 0.5rem 0 1rem;
  font-size: 2.6rem;
  line-height: 1.1;
  letter-spacing: 0;
}

.description {
  max-width: 610px;
  margin: 0;
  color: #526078;
  font-size: 1.05rem;
}

.api-status {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 1rem;
  margin-top: 3rem;
  padding: 1.25rem 0;
  border-top: 1px solid #dce3ef;
  border-bottom: 1px solid #dce3ef;
}

.api-status div {
  display: grid;
  gap: 0.4rem;
}

output {
  color: #26334a;
}

@media (max-width: 560px) {
  .content {
    padding-top: 4rem;
  }

  h1 {
    font-size: 2.1rem;
  }

  .api-status {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
