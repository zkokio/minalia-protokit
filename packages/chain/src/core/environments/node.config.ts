import {
  InMemorySigner,
  GraphqlBlockExplorerTransportModule,
  GraphqlClient,
  GraphqlNetworkStateTransportModule,
  GraphqlQueryTransportModule,
  GraphqlTransactionSender,
  ClientAppChain,
} from "@proto-kit/sdk";
import { PrivateKey } from "o1js";
import runtime from "../../runtime";
import { Runtime } from "@proto-kit/module";
import { Protocol } from "@proto-kit/protocol";
import { Sequencer } from "@proto-kit/sequencer";
import { VanillaProtocolModules } from "@proto-kit/library";

export function buildNodeClient(signerKey: PrivateKey, graphqlUrl: string) {
  const appChain = ClientAppChain.from({
    Runtime: Runtime.from(runtime.modules),
    Protocol: Protocol.from(VanillaProtocolModules.mandatoryModules({})),
    Sequencer: Sequencer.from({}),
    Signer: InMemorySigner,
    GraphqlClient,
    QueryTransportModule: GraphqlQueryTransportModule,
    NetworkStateTransportModule: GraphqlNetworkStateTransportModule,
    BlockExplorerTransportModule: GraphqlBlockExplorerTransportModule,
    TransactionSender: GraphqlTransactionSender,
  });

  appChain.configure({
    Runtime: runtime.config,
    GraphqlClient: { url: graphqlUrl },
    Protocol: VanillaProtocolModules.defaultConfig(),
    Signer: { signer: signerKey },
    Sequencer: {},
    QueryTransportModule: {},
    NetworkStateTransportModule: {},
    TransactionSender: {},
    BlockExplorerTransportModule: {},
  });

  return appChain;
}
