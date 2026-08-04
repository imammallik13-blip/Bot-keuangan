/**
 * useSupabaseAuthState
 * Pengganti useMultiFileAuthState bawaan Baileys.
 * Bedanya: kredensial login WhatsApp disimpan di tabel Supabase,
 * BUKAN di folder lokal (./auth_session) yang hilang tiap kali
 * Render restart / redeploy / spin down.
 *
 * Cara pakai (di index.js):
 *   const { useSupabaseAuthState } = require('./lib/supabaseAuthState');
 *   const { state, saveCreds } = await useSupabaseAuthState(supabase);
 *   const sock = makeWASocket({ auth: state, ... });
 *   sock.ev.on('creds.update', saveCreds);
 *
 * Butuh tabel `whatsapp_auth_state` di Supabase (lihat schema.sql).
 */

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const TABLE = 'whatsapp_auth_state';

async function useSupabaseAuthState(supabase, sessionId = 'default') {
  const writeData = async (key, data) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    const { error } = await supabase
      .from(TABLE)
      .upsert(
        { session_id: sessionId, key, value, updated_at: new Date().toISOString() },
        { onConflict: 'session_id,key' }
      );
    if (error) console.error(`[authState] gagal simpan key "${key}":`, error.message);
  };

  const readData = async (key) => {
    const { data, error } = await supabase
      .from(TABLE)
      .select('value')
      .eq('session_id', sessionId)
      .eq('key', key)
      .maybeSingle();
    if (error || !data) return null;
    try {
      return JSON.parse(data.value, BufferJSON.reviver);
    } catch {
      return null;
    }
  };

  const removeData = async (key) => {
    const { error } = await supabase
      .from(TABLE)
      .delete()
      .eq('session_id', sessionId)
      .eq('key', key);
    if (error) console.error(`[authState] gagal hapus key "${key}":`, error.message);
  };

  // Coba ambil creds yang sudah pernah tersimpan. Kalau belum ada
  // (login pertama kali), bikin creds kosong baru -> nanti kesimpen
  // otomatis lewat saveCreds() setelah scan QR berhasil.
  const existingCreds = await readData('creds');
  const creds = existingCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    },
    // Panggil ini kalau mau logout paksa / reset sesi dari kode
    clearState: async () => {
      await supabase.from(TABLE).delete().eq('session_id', sessionId);
    },
  };
}

module.exports = { useSupabaseAuthState };
