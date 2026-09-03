import { describe, expect, it } from 'vitest';

import { assertFederationOriginsApproved, parseDeploymentFederationPolicy } from './federationPolicy';

describe('Federation deployment policy', () => {
  it('normalizes the shell origin and accepts exact HTTPS plus loopback origins', () => {
    const trusted = parseDeploymentFederationPolicy(
      'https://cdn.example.test, http://127.0.0.1:4302',
      'https://workflow.example.test/shell',
    );
    expect([...trusted]).toEqual([
      'https://workflow.example.test',
      'https://cdn.example.test',
      'http://127.0.0.1:4302',
    ]);
  });

  it('fails closed for wildcard, path-scoped, and non-loopback HTTP policies', () => {
    for (const policy of ['*', 'https://cdn.example.test/assets', 'http://cdn.example.test']) {
      expect(() => parseDeploymentFederationPolicy(policy, 'https://workflow.example.test')).toThrow(
        /invalid origin/,
      );
    }
  });

  it('requires every signed resource origin to remain inside the deployment upper bound', () => {
    const trusted = parseDeploymentFederationPolicy(
      'https://cdn.example.test',
      'https://workflow.example.test',
    );
    expect(() =>
      assertFederationOriginsApproved(
        {
          manifestUrl: 'https://cdn.example.test/releases/abc/mf-manifest.json',
          resourceOrigins: ['https://cdn.example.test'],
        },
        trusted,
      ),
    ).not.toThrow();
    expect(() =>
      assertFederationOriginsApproved(
        {
          manifestUrl: 'https://cdn.example.test/releases/abc/mf-manifest.json',
          resourceOrigins: ['https://cdn.example.test', 'https://evil.example.test'],
        },
        trusted,
      ),
    ).toThrow(/not approved/);
  });
});
