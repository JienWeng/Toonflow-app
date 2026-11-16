<template>
  <el-card class="localCodexCard" shadow="never">
    <h3>Local Codex</h3>
    <p>Use the Codex login on the machine running Toonflow. No Toonflow account or API key is needed.</p>
    <el-form labelPosition="top" @submit.prevent="connect">
      <el-form-item label="Enable local Codex">
        <el-switch v-model="enabled" :disabled="loading" />
      </el-form-item>
      <el-form-item label="Codex executable">
        <el-input v-model="executable" :disabled="loading" placeholder="codex" autocomplete="off" />
      </el-form-item>
      <el-alert v-if="message" :title="message" :type="connected ? 'success' : 'info'" :closable="false" showIcon />
      <p v-if="connected">{{ modelCount }} models available</p>
      <p v-else>Install Codex CLI and run <code>codex login</code> on the server machine, then refresh the connection.</p>
      <el-button type="primary" nativeType="submit" :loading="loading">Save and refresh</el-button>
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import axios from "axios";
import { onMounted, onBeforeUnmount, ref } from "vue";
import { refreshModelChoices, saveSettings, settings } from "@/stores/settings";

const saved = settings.value.localCodex as { enabled?: boolean; executable?: string } | undefined;
const enabled = ref(saved?.enabled !== false);
const executable = ref(saved?.executable ?? "codex");
const loading = ref(false);
const message = ref("");
const connected = ref(false);
const modelCount = ref(0);
const lifetime = new AbortController();
onBeforeUnmount(() => lifetime.abort());
onMounted(() => { void refresh(); });

async function refresh() {
  loading.value = true;
  try {
    const { data } = await axios.get("/api/providers/codex/status", { signal: lifetime.signal, timeout: 70000 });
    if (data.code !== 200) throw new Error(data.message || "Could not connect to local Codex");
    connected.value = data.data.authenticated && data.data.models.length > 0;
    modelCount.value = data.data.models.length;
    message.value = data.data.message;
    await refreshModelChoices(true, lifetime.signal);
  } catch (cause) {
    if (!lifetime.signal.aborted) {
      connected.value = false;
      message.value = axios.isAxiosError(cause) ? cause.response?.data?.message || cause.message : cause instanceof Error ? cause.message : "Could not connect to local Codex";
    }
  } finally { loading.value = false; }
}

async function connect() {
  if (loading.value) return;
  if (!executable.value.trim()) { message.value = "Enter the Codex executable name or absolute path"; return; }
  loading.value = true;
  try {
    await saveSettings(() => ({ localCodex: { enabled: enabled.value, executable: executable.value.trim() } }), lifetime.signal);
  } catch (cause) {
    if (!lifetime.signal.aborted) message.value = cause instanceof Error ? cause.message : "Could not save Codex settings";
    return;
  } finally { loading.value = false; }
  await refresh();
}
</script>

<style scoped lang="scss">
.localCodexCard {
  h3 { margin: 0 0 8px; }
  p { color: var(--el-text-color-secondary); line-height: 1.6; overflow-wrap: anywhere; }
  code { color: var(--el-text-color-primary); }
}
</style>
