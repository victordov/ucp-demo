/* ============ Passkey (WebAuthn / SPC) client ============
 * Real Touch ID on macOS via WebAuthn, with a best-effort Secure Payment
 * Confirmation (SPC, Chrome) path that shows the native amount/instrument
 * sheet. Both produce an assertion the Credentials Provider verifies. Falls
 * back gracefully so users who don't enrol are never blocked.
 */
window.Passkey = (() => {
  const W = window.SimpleWebAuthnBrowser;

  // Reuse SimpleWebAuthn's own base64url <-> buffer helpers (one well-tested
  // implementation) rather than hand-rolling them. base64URLStringToBuffer →
  // ArrayBuffer (a valid BufferSource for SPC); bufferToBase64URLString ← buffer.
  const b64uToBuf = W.base64URLStringToBuffer;
  const bufToB64u = W.bufferToBase64URLString;

  // 1×1 transparent PNG — SPC requires an instrument icon URL.
  const ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  async function spcAuth(options, payment, amount, payee) {
    if (!window.PaymentRequest || !payment) return null;
    let request;
    try {
      request = new PaymentRequest(
        [{
          supportedMethods: "secure-payment-confirmation",
          data: {
            rpId: options.rpId,
            credentialIds: (options.allowCredentials || []).map((c) => b64uToBuf(c.id)),
            challenge: b64uToBuf(options.challenge),
            instrument: { displayName: `${(payment.network || "card").toUpperCase()} ••${payment.last4 || ""}`, icon: ICON },
            payeeName: payee || "Merchant",
            timeout: 60000,
          },
        }],
        { total: { label: "Total", amount: { currency: "USD", value: String(amount) } } }
      );
    } catch (e) { return null; }
    if (!(await request.canMakePayment().catch(() => false))) return null;
    const resp = await request.show();
    await resp.complete("success");
    const cred = resp.details;
    return {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64u(cred.response.clientDataJSON),
        authenticatorData: bufToB64u(cred.response.authenticatorData),
        signature: bufToB64u(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : undefined,
      },
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      authenticatorAttachment: cred.authenticatorAttachment || "platform",
    };
  }

  // A passkey is scoped to its RP ID = the effective domain of THIS wallet page.
  // Pin every ceremony to location.hostname so it works identically on localhost
  // and behind ngrok / localtunnel (and survives ngrok's rotating subdomains) —
  // never a stale, server-baked RP ID that mismatches the page. The `hint` steers
  // the authenticator: "client-device" = the built-in platform authenticator
  // (macOS Touch ID, the default — so the browser doesn't hand the ceremony to a
  // password-manager extension like LastPass); "hybrid" = a phone / QR, letting
  // the user deliberately pick another device.
  function pinCeremony(options, kind, hint) {
    const o = Object.assign({}, options);
    o.hints = [hint || "client-device"];
    if (kind === "register") {
      o.rp = Object.assign({}, o.rp, { id: location.hostname });
      o.authenticatorSelection = Object.assign(
        { residentKey: "preferred", userVerification: "required" },
        o.authenticatorSelection,
        { authenticatorAttachment: hint === "hybrid" ? "cross-platform" : "platform" }
      );
    } else {
      o.rpId = location.hostname;
    }
    return o;
  }

  return {
    available: () => !!(window.PublicKeyCredential && W),
    // auth({ ..., prefer }): returns { assertion, method: 'spc' | 'webauthn' }.
    // prefer === "hybrid" routes to a phone / QR and skips the platform-only SPC
    // sheet, so the user can choose another device instead of macOS Touch ID.
    async auth({ options, payment, amount, payee, prefer }) {
      const hint = prefer === "hybrid" ? "hybrid" : "client-device";
      const opts = pinCeremony(options, "auth", hint);
      if (prefer !== "hybrid") {
        try {
          const spc = await spcAuth(opts, payment, amount, payee);
          if (spc) return { assertion: spc, method: "spc" };
        } catch (e) { console.warn("[passkey] SPC unavailable, using WebAuthn:", e.message); }
      }
      const assertion = await W.startAuthentication({ optionsJSON: opts });
      return { assertion, method: "webauthn" };
    },
    async register(options) {
      return W.startRegistration({ optionsJSON: pinCeremony(options, "register", "client-device") });
    },
  };
})();
