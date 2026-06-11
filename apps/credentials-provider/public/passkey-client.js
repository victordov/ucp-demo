/* ============ Passkey (WebAuthn / SPC) client ============
 * Real Touch ID on macOS via WebAuthn, with a best-effort Secure Payment
 * Confirmation (SPC, Chrome) path that shows the native amount/instrument
 * sheet. Both produce an assertion the Credentials Provider verifies. Falls
 * back gracefully so users who don't enrol are never blocked.
 */
window.Passkey = (() => {
  const W = window.SimpleWebAuthnBrowser;

  const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const bufToB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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

  return {
    available: () => !!(window.PublicKeyCredential && W),
    // Returns { assertion, method: 'spc' | 'webauthn' }
    async auth({ options, payment, amount, payee }) {
      try {
        const spc = await spcAuth(options, payment, amount, payee);
        if (spc) return { assertion: spc, method: "spc" };
      } catch (e) { console.warn("[passkey] SPC unavailable, using WebAuthn:", e.message); }
      const assertion = await W.startAuthentication({ optionsJSON: options });
      return { assertion, method: "webauthn" };
    },
    async register(options) {
      return W.startRegistration({ optionsJSON: options });
    },
  };
})();
