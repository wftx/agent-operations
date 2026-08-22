export type RepositoryIdentityKind = 'remote' | 'local';
export type RepositoryAvailability = 'available' | 'degraded' | 'unavailable' | 'not-a-repository';
export type WorkingTreeState = 'clean' | 'dirty' | 'unknown';

/** Host/path identity shared by equivalent Git transports. */
export interface RemoteRepositoryIdentity {
  readonly host: string;
  readonly repositoryPath: string;
  readonly canonical: string;
}

export interface RepositoryRemote {
  readonly name: string;
  /** Sanitized configured URL. URL-embedded credentials are never returned. */
  readonly fetchUrl: string;
  readonly pushUrl?: string;
  readonly identity?: RemoteRepositoryIdentity;
}

export interface RepositorySummary {
  readonly id: string;
  readonly identityKind: RepositoryIdentityKind;
  readonly name: string;
  readonly checkoutPath: string;
  readonly repositoryRoot?: string;
  readonly availability: RepositoryAvailability;
  readonly branch?: string;
  readonly detachedHead: boolean;
  readonly headCommit?: string;
  readonly workingTree: WorkingTreeState;
  readonly remotes: readonly RepositoryRemote[];
  readonly primaryRemote?: RepositoryRemote;
  readonly observedAt: string;
  readonly reason?: string;
}

/** Read-only repository observation boundary owned by Agent Operations. */
export interface RepositoryInventoryAdapter {
  inspectRepository(checkoutPath: string): Promise<RepositorySummary>;
}
