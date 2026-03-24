import { Markup } from 'telegraf';
import { MESSAGES } from '../../../constants/messages';
import { Project } from '../../../models/project';
import { AgentSession, AgentProject } from '../../../utils/agent-session-reader';
import { AgentModel, AgentProvider, getModelsForProvider, ModelInfo } from '../../../models/types';

export class KeyboardFactory {
  static createProjectTypeKeyboard(): any {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(MESSAGES.BUTTONS.GITHUB_REPO, 'project_type_github'),
        Markup.button.callback(MESSAGES.BUTTONS.LOCAL_DIRECTORY, 'project_type_directory'),
      ],
      [
        Markup.button.callback(MESSAGES.BUTTONS.CANCEL, 'cancel'),
      ],
    ]);
  }

  static createCancelKeyboard(): any {
    return Markup.inlineKeyboard([
      Markup.button.callback(MESSAGES.BUTTONS.CANCEL, 'cancel'),
    ]);
  }

  static createCompletionKeyboard(): any {
    return Markup.keyboard([
      ['/clear', '/abort']
    ]).resize();
  }

  static createASRConfirmKeyboard(): any {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('❌ Cancel', 'asr_cancel'),
        Markup.button.callback('✏️ Edit', 'asr_edit'),
        Markup.button.callback('✅ Confirm', 'asr_confirm'),
      ],
    ]);
  }

  static createProjectListKeyboard(projects: Project[]): any {
    const keyboard = [];
    
    // Add project buttons, 2 per row
    for (let i = 0; i < projects.length; i += 2) {
      const row = [];
      const project1 = projects[i];
      const project2 = projects[i + 1];
      
      if (project1) {
        row.push(Markup.button.callback(
          `${project1.type === 'git' ? '🔗' : '📂'} ${project1.name}`,
          `project_select_${project1.id}`
        ));
      }
      
      if (project2) {
        row.push(Markup.button.callback(
          `${project2.type === 'git' ? '🔗' : '📂'} ${project2.name}`,
          `project_select_${project2.id}`
        ));
      }
      
      if (row.length > 0) {
        keyboard.push(row);
      }
    }
    
    // Add action buttons
    keyboard.push([
      Markup.button.callback('❌ cancel', 'cancel')
    ]);
    
    return Markup.inlineKeyboard(keyboard);
  }

  static createDirectoryKeyboard(browsingState: any): any {
    const { currentPage, itemsPerPage, totalItems, items } = browsingState;
    const keyboard = [];

    // Calculate pagination
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const pageItems = items.slice(startIndex, endIndex);

    // Add file/directory buttons (2 per row)
    for (let i = 0; i < pageItems.length; i += 2) {
      const row = [];
      const item1 = pageItems[i];
      const item2 = pageItems[i + 1];

      if (item1) {
        row.push(Markup.button.callback(
          `${item1.icon} ${item1.name}`,
          `${item1.type}:${encodeURIComponent(item1.name)}`
        ));
      }

      if (item2) {
        row.push(Markup.button.callback(
          `${item2.icon} ${item2.name}`,
          `${item2.type}:${encodeURIComponent(item2.name)}`
        ));
      }

      if (row.length > 0) {
        keyboard.push(row);
      }
    }

    // Add navigation buttons
    const navRow = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('⬅️ Previous', `nav:page:${currentPage - 1}`));
    }
    if (browsingState.currentPath !== '/') {
      navRow.push(Markup.button.callback('📂 Parent', 'nav:parent'));
    }
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `nav:page:${currentPage + 1}`));
    }

    if (navRow.length > 0) {
      keyboard.push(navRow);
    }

    // Add action buttons
    keyboard.push([
      Markup.button.callback('🔄 Refresh', 'nav:refresh'),
      Markup.button.callback('❌ Close', 'nav:close')
    ]);

    return Markup.inlineKeyboard(keyboard);
  }

  static createProjectCatalogKeyboard(projects: AgentProject[], showCreateButtons: boolean = true): any {
    const keyboard = [];

    // Add project buttons (1 per row)
    for (const project of projects) {
      const dateStr = project.lastAccessed.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
      });

      // Use last directory name from path
      const displayName = project.name.length > 18
        ? project.name.substring(0, 18) + '..'
        : project.name;

      // Truncate ID to fit Telegram's 64 byte limit
      // "project_catalog_" = 15 bytes, so max ID length is 49 bytes
      const shortId = project.id.length > 45
        ? project.id.substring(project.id.length - 45)
        : project.id;

      keyboard.push([
        Markup.button.callback(
          `📂 ${displayName} (${dateStr})`,
          `project_catalog_${shortId}`
        )
      ]);
    }

    // Add create new project buttons
    if (showCreateButtons) {
      keyboard.push([
        Markup.button.callback('🔗 GitHub Repository', 'project_type_github'),
        Markup.button.callback('📂 Local Directory', 'project_type_directory')
      ]);
    }

    // Add cancel button
    keyboard.push([
      Markup.button.callback('❌ Cancel', 'cancel')
    ]);

    return Markup.inlineKeyboard(keyboard);
  }

  static createSessionListKeyboard(sessions: AgentSession[]): any {
    const keyboard = [];

    // Add session buttons (1 per row due to long text)
    for (const session of sessions) {
      const date = new Date(session.timestamp);
      const dateStr = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      // Truncate first message for display
      let summary = session.firstMessage || 'No message';
      if (summary.length > 25) {
        summary = summary.substring(0, 25) + '...';
      }

      keyboard.push([
        Markup.button.callback(
          `📝 ${dateStr} - ${summary}`,
          `session_select_${session.sessionId}`
        )
      ]);
    }

    // Add cancel button
    keyboard.push([
      Markup.button.callback('❌ Cancel', 'cancel')
    ]);

    return Markup.inlineKeyboard(keyboard);
  }

  static createModelSelectionKeyboard(currentModel: AgentModel, provider: AgentProvider, models: ModelInfo[]): any {
    const rows = [];
    for (let i = 0; i < models.length; i += 2) {
      const row = [];
      const first = models[i];
      const second = models[i + 1];

      if (first) {
        const isSelected = first.value === currentModel && first.provider === provider;
        const label = `${first.provider} - ${first.displayName}${isSelected ? ' ✓' : ''}`;
        row.push(Markup.button.callback(label, `model_select:${first.provider}:${encodeURIComponent(first.value)}`));
      }

      if (second) {
        const isSelected = second.value === currentModel && second.provider === provider;
        const label = `${second.provider} - ${second.displayName}${isSelected ? ' ✓' : ''}`;
        row.push(Markup.button.callback(label, `model_select:${second.provider}:${encodeURIComponent(second.value)}`));
      }

      if (row.length > 0) {
        rows.push(row);
      }
    }

    rows.push([Markup.button.callback('❌ Cancel', 'cancel')]);
    return Markup.inlineKeyboard(rows);
  }

  // Onboarding keyboards
  static createOnboardingWelcomeKeyboard(): any {
    return Markup.inlineKeyboard([
      [Markup.button.callback('➡️ Continue', 'onboarding_continue')]
    ]);
  }

  static createOnboardingDisclaimerKeyboard(): any {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('❌ Decline', 'onboarding_decline'),
        Markup.button.callback('✅ I Accept', 'onboarding_accept')
      ]
    ]);
  }

  static createOnboardingModelKeyboard(currentModel: AgentModel, provider: AgentProvider): any {
    const buttons = getModelsForProvider(provider).map(model => {
      const isSelected = model.value === currentModel;
      const label = isSelected ? `${model.displayName} ✓` : model.displayName;
      return Markup.button.callback(label, `onboarding_model:${model.value}`);
    });

    return Markup.inlineKeyboard([
      buttons,
      [Markup.button.callback('➡️ Continue', 'onboarding_model_done')]
    ]);
  }

  static createDirectoryPickerKeyboard(browsingState: any): any {
    const { currentPage, itemsPerPage, totalItems, items } = browsingState;
    const keyboard = [];

    // Calculate pagination
    const totalPages = Math.ceil(totalItems / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalItems);
    const pageItems = items.slice(startIndex, endIndex);

    // Show only directories (2 per row)
    const dirItems = pageItems.filter((item: any) => item.type === 'directory');
    for (let i = 0; i < dirItems.length; i += 2) {
      const row = [];
      const item1 = dirItems[i];
      const item2 = dirItems[i + 1];

      if (item1) {
        row.push(Markup.button.callback(
          `📁 ${item1.name}`,
          `pick_dir:${encodeURIComponent(item1.name)}`
        ));
      }
      if (item2) {
        row.push(Markup.button.callback(
          `📁 ${item2.name}`,
          `pick_dir:${encodeURIComponent(item2.name)}`
        ));
      }
      if (row.length > 0) {
        keyboard.push(row);
      }
    }

    // Navigation buttons
    const navRow = [];
    if (currentPage > 1) {
      navRow.push(Markup.button.callback('⬅️ Previous', `pick_nav:page:${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback('📂 Parent', 'pick_nav:parent'));
    if (currentPage < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `pick_nav:page:${currentPage + 1}`));
    }
    keyboard.push(navRow);

    // Search button
    keyboard.push([
      Markup.button.callback('🔍 Search / Go to path', 'pick_search')
    ]);

    // Action buttons: Select this directory + Cancel
    keyboard.push([
      Markup.button.callback('✅ Select This Directory', 'pick_select'),
      Markup.button.callback('❌ Cancel', 'pick_cancel')
    ]);

    return Markup.inlineKeyboard(keyboard);
  }

  static createOnboardingProjectKeyboard(): any {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback('🔗 GitHub Repository', 'onboarding_project_github'),
        Markup.button.callback('📂 Local Directory', 'onboarding_project_local')
      ],
      [Markup.button.callback('⏭️ Skip for Now', 'onboarding_skip')]
    ]);
  }
}
