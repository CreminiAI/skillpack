export const state = {
  config: null,
  API_BASE: ""
};

export async function loadConfig() {
  try {
    const res = await fetch(state.API_BASE + "/api/config");
    state.config = await res.json();
    return state.config;
  } catch (err) {
    console.error("Failed to load config:", err);
    throw err;
  }
}
