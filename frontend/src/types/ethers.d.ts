declare module "ethers" {
  // Minimal stub to satisfy TS during frontend typecheck.
  // This repo’s demo test file isn’t run as part of the UI flow.

  export type Eip1193Provider = any;
  export type TransactionReceipt = any;
  export type TransactionRequest = any;

  // The demo test file uses `ethers.SomeType` in type positions (namespace merge).
  export namespace ethers {
    export type Eip1193Provider = any;
    export type TransactionReceipt = any;
    export type TransactionRequest = any;
  }

  export const ethers: any;

  export class BrowserProvider {
    constructor(...args: any[]);
    send(...args: any[]): Promise<any>;
    getSigner(...args: any[]): any;
    getNetwork(...args: any[]): Promise<any>;
  }

  export class Interface {
    constructor(...args: any[]);
    parseLog(...args: any[]): any;
  }

  export default ethers;
}

