# AXIOM Package Format v0.1

`.axiom` is the portable exchange format for trusted AXIOM data.

It is not runtime storage.
It is not a database format.
It is not a replacement for SQLite, Postgres, or storage adapters.

## Purpose

`.axiom` packages move trusted AXIOM data between systems in a portable and inspectable way.

## Relationship to ATP

- ATP defines the object contracts.
- `.axiom` defines packaging and portability.
- `.axiom` packages carry ATP-compatible objects.

## Core principle

`.axiom` is not storage.
`.axiom` is a portable trust package.

## v0.1 use cases

- Export a Trust Receipt bundle
- Export a project or workspace trust snapshot
- Export provenance and audit trail data for review
- Export candidate claims for external review
- Export causal simulation evidence
- Move trusted claims between AXIOM instances
- Send a compact trust package to another AI system

## v0.1 non-goals

- live sync
- database backup
- authorization
- encryption
- signing
- conflict resolution workflow
- full workspace migration

## Package shape

A logical `.axiom` package contains:

- `manifest`
- `objects`
- `index`
- `metadata`

The manifest must include:

- `packageId`
- `format: "axiom-package"`
- `formatVersion: "0.1"`
- `createdAt`
- `createdBy`
- `workspaceId`
- `source`
- `description`
- `objectCounts`
- `atpVersion: "0.1"`

## Required package rules

- `format` must be `axiom-package`
- `formatVersion` must be `0.1`
- `atpVersion` must be `0.1`
- `workspaceId` is required
- `packageId` is required
- `createdAt` is required
- `objectCounts` should match the object arrays when possible
- every embedded object must be ATP-compatible or use an extension namespace
- extension fields must not override canonical ATP fields
- `provenanceId`, `sourceRef`, `trustPolicyVersion`, and claim status must be preserved
- audit events remain append-only historical records

## Extension namespace

Use `x-*` for extensions.

Examples:

- `x-vendor-field`
- `x-axiom-experimental`

Unknown extension fields must not invalidate the package by default.
Core ATP fields still must validate.

## Future PRs may add

- `exportAxiomPackage()`
- `importAxiomPackage()`
- signed packages
- compressed packages
- encrypted packages
- package registry
- `axiom verify` package command

PR-8.5 only defines the draft package format and validation fixtures.

