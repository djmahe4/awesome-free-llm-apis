export interface NormalizedAdvisory {
  packageName: string;
  severity: string;
  title: string;
  advisoryId?: string;
  url?: string;
  cve?: string;
}

export interface InternalCallSite {
  caller: string;
  calleePackage: string;
  calleeMethod?: string;
  line: number;
}

export interface TaintedCallSite {
  caller: string;
  calleePackage: string;
  calleeMethod?: string;
  line: number;
  severity?: string;
  vulnerabilityTitle?: string;
  advisoryId?: string;
}

export interface ShallowCloneConsentRequest {
  action: 'prompt_user_consent' | string;
  command: string;
  reason: string;
  requiresConfirmation: boolean;
}

export interface EcosystemAuditReport {
  npm?: any;
  cargo?: any;
  pip?: any;
  [key: string]: any;
}

export class AuditTaintBridge {
  normalizeNpmAudit(report: any): NormalizedAdvisory[] {
    if (
      !report ||
      !report.vulnerabilities ||
      typeof report.vulnerabilities !== 'object' ||
      Array.isArray(report.vulnerabilities)
    ) {
      return [];
    }
    const results: NormalizedAdvisory[] = [];
    for (const [pkgName, vulnData] of Object.entries<any>(report.vulnerabilities)) {
      if (!vulnData) continue;
      const viaFirst = Array.isArray(vulnData.via) && vulnData.via.length > 0 ? vulnData.via[0] : undefined;
      const viaObj = typeof viaFirst === 'object' && viaFirst !== null ? viaFirst : undefined;

      const packageName = vulnData.name || pkgName;
      const severity = vulnData.severity || 'high';
      const title = viaObj?.title || (typeof viaFirst === 'string' ? viaFirst : vulnData.title || `Vulnerability in ${packageName}`);
      const rawUrl = viaObj?.url || vulnData.url;
      const url = typeof rawUrl === 'string' ? rawUrl : undefined;
      let rawId = viaObj?.source ?? viaObj?.id;
      if (rawId === undefined && typeof url === 'string') {
        const trimmed = url.replace(/\/+$/, '');
        const parts = trimmed.split('/');
        rawId = parts[parts.length - 1];
      }
      const advisoryId = rawId !== undefined && rawId !== null && rawId !== '' ? String(rawId) : undefined;

      results.push({
        packageName,
        severity,
        title,
        advisoryId,
        url,
      });
    }
    return results;
  }

  normalizeCargoAudit(report: any): NormalizedAdvisory[] {
    if (!report) return [];
    const rawList: any[] = Array.isArray(report.vulnerabilities?.list)
      ? report.vulnerabilities.list
      : Array.isArray(report.vulnerabilities)
      ? report.vulnerabilities
      : Array.isArray(report.warnings)
      ? report.warnings
      : [];

    const results: NormalizedAdvisory[] = [];
    for (const item of rawList) {
      if (!item) continue;
      const packageName = item.package?.name || item.advisory?.package || item.name || '';
      const advisory = item.advisory || {};
      const severity = advisory.severity || item.severity || 'high';
      const title = advisory.title || item.title || `Vulnerability in ${packageName}`;
      const advisoryId = advisory.id || item.id;
      const url = advisory.url || item.url;

      results.push({
        packageName,
        severity,
        title,
        advisoryId,
        url,
      });
    }
    return results;
  }

  normalizePipAudit(report: any): NormalizedAdvisory[] {
    if (!report) return [];
    const list: any[] = Array.isArray(report)
      ? report
      : Array.isArray(report.dependencies)
      ? report.dependencies
      : [];

    const results: NormalizedAdvisory[] = [];
    for (const item of list) {
      if (!item) continue;
      const packageName = item.name || '';
      const vulns: any[] = Array.isArray(item.vulns) ? item.vulns : [];
      for (const vuln of vulns) {
        if (!vuln) continue;
        const title = vuln.description || vuln.id || `Vulnerability in ${packageName}`;
        const advisoryId = vuln.id;
        const cve = Array.isArray(vuln.aliases) && vuln.aliases.length > 0 ? vuln.aliases[0] : undefined;
        const severity = vuln.severity || 'high';
        const url = vuln.link || vuln.url;

        results.push({
          packageName,
          severity,
          title,
          advisoryId,
          cve,
          url,
        });
      }
    }
    return results;
  }

  findTaintedCallSites(internalSites: InternalCallSite[], advisories: NormalizedAdvisory[]): TaintedCallSite[] {
    if (!Array.isArray(internalSites) || !Array.isArray(advisories)) {
      return [];
    }
    const results: TaintedCallSite[] = [];
    for (const site of internalSites) {
      if (!site || typeof site.calleePackage !== 'string') continue;
      const matchedAdvisories = advisories.filter(
        (adv) =>
          adv &&
          typeof adv.packageName === 'string' &&
          adv.packageName.toLowerCase() === site.calleePackage.toLowerCase()
      );
      for (const matchedAdv of matchedAdvisories) {
        results.push({
          caller: site.caller,
          calleePackage: site.calleePackage,
          calleeMethod: site.calleeMethod,
          line: site.line,
          severity: matchedAdv.severity,
          vulnerabilityTitle: matchedAdv.title,
          advisoryId: matchedAdv.advisoryId,
        });
      }
    }
    return results;
  }

  createShallowClonePrompt(repoUrl: string, reason: string): ShallowCloneConsentRequest {
    const allowedProtocols = ['https://', 'http://', 'git@', 'git://'];
    const shellMetaChars = /[;&|`$\n\r><]/;
    if (
      typeof repoUrl !== 'string' ||
      repoUrl.startsWith('-') ||
      !allowedProtocols.some((proto) => repoUrl.startsWith(proto)) ||
      shellMetaChars.test(repoUrl)
    ) {
      throw new Error(`Invalid or unsafe repository URL: ${repoUrl}`);
    }
    return {
      action: 'prompt_user_consent',
      command: `git clone --depth 1 ${repoUrl}`,
      reason,
      requiresConfirmation: true,
    };
  }
}
