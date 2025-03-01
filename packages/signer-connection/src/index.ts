import { EventEmitter } from "events";
import { IJsonRpcConnection } from "@json-rpc-tools/types";
import { formatJsonRpcError, formatJsonRpcResult } from "@json-rpc-tools/utils";

import { Client, CLIENT_EVENTS } from "@walletconnect/client";
import { ERROR } from "@walletconnect/utils";
import { ClientOptions, IClient, PairingTypes, SessionTypes } from "@walletconnect/types";

export function isClient(opts?: SignerConnectionClientOpts): opts is IClient {
  return typeof opts !== "undefined" && typeof (opts as IClient).context !== "undefined";
}

export const SIGNER_EVENTS = {
  init: "signer_init",
  uri: "signer_uri",
  created: "signer_created",
  updated: "signer_updated",
  deleted: "signer_deleted",
  notification: "signer_notification",
};

export type SignerConnectionClientOpts = IClient | ClientOptions;
export interface SignerConnectionOpts {
  chains?: string[];
  methods?: string[];
  client?: SignerConnectionClientOpts;
}

export class SignerConnection extends IJsonRpcConnection {
  public events: any = new EventEmitter();

  public chains: string[];
  public methods: string[];

  private pending = false;
  private session: SessionTypes.Settled | undefined;

  private client: IClient | undefined;
  private initializing = false;

  constructor(opts?: SignerConnectionOpts) {
    super();

    this.chains = opts?.chains || [];
    this.methods = opts?.methods || [];
    this.register(opts?.client);
  }

  get connected(): boolean {
    return typeof this.session !== "undefined";
  }

  get connecting(): boolean {
    return this.pending;
  }

  public on(event: string, listener: any) {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any) {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any) {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any) {
    this.events.removeListener(event, listener);
  }

  public async open(): Promise<void> {
    this.pending = true;
    const client = await this.register();
    this.session = await client.connect({
      permissions: {
        blockchain: { chains: this.chains },
        jsonrpc: { methods: this.methods },
      },
    });
    this.onOpen();
  }

  public async close() {
    if (typeof this.session === "undefined") {
      return;
    }
    const client = await this.register();
    await client.disconnect({
      topic: this.session.topic,
      reason: ERROR.USER_DISCONNECTED.format(),
    });
    this.onClose();
  }

  public async send(payload: any, context?: any) {
    if (typeof this.client === "undefined") {
      this.client = await this.register();
      if (!this.connected) await this.open();
    }
    if (typeof this.session === "undefined") {
      throw new Error("Signer connection is missing session");
    }
    this.client
      .request({ topic: this.session.topic, request: payload, chainId: context?.chainId })
      .then((result: any) => this.events.emit("payload", formatJsonRpcResult(payload.id, result)))
      .catch(e => this.events.emit("payload", formatJsonRpcError(payload.id, e.message)));
  }

  // ---------- Private ----------------------------------------------- //

  private async register(opts?: SignerConnectionClientOpts): Promise<IClient> {
    if (typeof this.client !== "undefined") {
      return this.client;
    }
    if (this.initializing) {
      return new Promise((resolve, reject) => {
        this.events.once(SIGNER_EVENTS.init, () => {
          if (typeof this.client === "undefined") {
            return reject(new Error("Client not initialized"));
          }
          resolve(this.client);
        });
      });
    }
    if (isClient(opts)) {
      this.client = opts;
      this.registerEventListeners();
      return this.client;
    }
    this.initializing = true;
    this.client = await Client.init(opts);
    this.initializing = false;
    this.registerEventListeners();
    this.events.emit(SIGNER_EVENTS.init);
    return this.client;
  }

  private onOpen(session?: SessionTypes.Settled) {
    this.pending = false;
    if (session) {
      this.session = session;
    }
    this.events.emit("open");
  }

  private onClose() {
    this.pending = false;
    if (this.client) {
      this.client = undefined;
    }
    this.events.emit("close");
  }

  private registerEventListeners() {
    if (typeof this.client === "undefined") return;
    this.client.on(CLIENT_EVENTS.session.created, (session: SessionTypes.Settled) => {
      if (this.session && this.session?.topic !== session.topic) return;
      this.session = session;
      this.events.emit(SIGNER_EVENTS.created, session);
    });
    this.client.on(CLIENT_EVENTS.session.updated, (session: SessionTypes.Settled) => {
      if (this.session && this.session?.topic !== session.topic) return;
      this.session = session;
      this.events.emit(SIGNER_EVENTS.updated, session);
    });
    this.client.on(
      CLIENT_EVENTS.session.notification,
      (notification: SessionTypes.NotificationEvent) => {
        if (this.session && this.session?.topic !== notification.topic) return;
        this.events.emit(SIGNER_EVENTS.notification, {
          type: notification.type,
          data: notification.data,
        });
      },
    );
    this.client.on(CLIENT_EVENTS.session.deleted, (session: SessionTypes.Settled) => {
      if (!this.session) return;
      if (this.session && this.session?.topic !== session.topic) return;
      this.onClose();
      this.events.emit(SIGNER_EVENTS.deleted, session);
    });
    this.client.on(CLIENT_EVENTS.pairing.proposal, async (proposal: PairingTypes.Proposal) => {
      const uri = proposal.signal.params.uri;
      this.events.emit(SIGNER_EVENTS.uri, { uri });
    });
  }
}

export default SignerConnection;
