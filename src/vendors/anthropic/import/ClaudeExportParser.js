/**
 * Extracts the app's own record shapes from claude.ai's data-export JSON, for every category
 * besides conversations (already the right shape - see ClaudeExportMapper). Each method takes
 * already-parsed JSON, since how the file itself is selected and read is a UI concern.
 */
export class ClaudeExportParser {
  /**
   * Memory files from one account's memories export.
   * @param {{account_uuid: string, memory_files: Array<{path: string, content: string, updated_at: string}>}} memoriesJson Parsed memories-000 content.
   * @returns {ImportedMemoryFileRecord[]} The memory files.
   */
  static memoryFiles(memoriesJson) {
    return memoriesJson.memory_files.map(file => ({
      accountId: memoriesJson.account_uuid,
      path: file.path,
      content: file.content,
      updatedAt: file.updated_at,
    }));
  }

  /**
   * One Artifact's content from its frames-000 folder.
   * @param {{id: string, versions: Array<{id: string, title: string}>, active_version: string}} artifactJson Parsed artifact.json content.
   * @param {Map<string, string>} htmlByVersionId Each version's HTML, by version id.
   * @returns {ImportedArtifactRecord} The Artifact record.
   */
  static artifact(artifactJson, htmlByVersionId) {
    return {
      artifactId: artifactJson.id,
      title: artifactJson.versions.find(version => version.id === artifactJson.active_version)?.title ?? '',
      activeVersionId: artifactJson.active_version,
      html: htmlByVersionId.get(artifactJson.active_version) ?? '',
      knownVersionIds: artifactJson.versions.map(version => version.id),
    };
  }

  /**
   * One Project's content from its projects-000 file.
   * @param {object} projectJson Parsed projects-000/projects/<id>.json content.
   * @returns {ImportedProjectRecord} The Project record.
   */
  static project(projectJson) {
    return {
      projectId: projectJson.uuid,
      name: projectJson.name,
      description: projectJson.description,
      promptTemplate: projectJson.prompt_template,
      updatedAt: projectJson.updated_at,
      docs: projectJson.docs.map(doc => ({ docId: doc.uuid, filename: doc.filename, content: doc.content, createdAt: doc.created_at })),
    };
  }

  /**
   * Feedback/reflection periods from one account's feedback export.
   * @param {{account_uuid: string, reflections: Array<{period: string, content: object}>}} feedbackJson Parsed feedback-000 content.
   * @returns {ImportedFeedbackPeriodRecord[]} The periods.
   */
  static feedbackPeriods(feedbackJson) {
    return feedbackJson.reflections.map(reflection => ({
      accountId: feedbackJson.account_uuid,
      period: reflection.period,
      content: reflection.content,
    }));
  }

  /**
   * The account profile from a light_metadata export's users.json.
   * @param {Array<{uuid: string, full_name: string, email_address: string}>} usersJson Parsed users.json content.
   * @returns {ImportedAccountProfileRecord} The profile.
   */
  static accountProfile(usersJson) {
    const user = usersJson[0];
    return { accountId: user.uuid, fullName: user.full_name, emailAddress: user.email_address };
  }

  /**
   * Login events from a light_metadata export's login_history.json.
   * @param {{login_events: Array<object>}} loginHistoryJson Parsed login_history.json content.
   * @returns {ImportedLoginEventRecord[]} The events.
   */
  static loginEvents(loginHistoryJson) {
    return loginHistoryJson.login_events.map(event => ({
      accountId: event.account_uuid,
      timestamp: event.timestamp,
      ipAddress: event.ip_address,
      userAgent: event.user_agent,
      method: event.method,
      locationInfo: event.location_info,
    }));
  }
}
