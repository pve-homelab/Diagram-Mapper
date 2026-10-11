# Diagram Mapper — Constraints and Operating Principles

## 1. Deadlines and Budget

There is currently no fixed deadline or approved development budget.

- Prioritise quality, security, maintainability, and commercial viability over rushing to meet an arbitrary deadline.
- Develop a realistic roadmap with milestones, dependencies, estimated costs, and measurable acceptance criteria.
- Prefer cost-effective and open-source solutions where practical.
- Identify recurring costs for hosting, AI APIs, databases, storage, subscriptions, and third-party services.
- Obtain my approval before incurring significant costs or making financial commitments.
- Do not sacrifice essential functionality, security, or reliability simply to accelerate delivery.

## 2. Existing Project and Source of Truth

GitHub repository: https://github.com/pve-homelab/Diagram-Mapper

The existing repository is the starting point for all development.

Before making significant changes:

1. Read `PROMPT.md` to understand the original product vision and intended functionality.
2. Read `First_Team_outcome.md` to understand the desired business outcome.
3. Audit the entire repository, including existing code, documentation, dependencies, configuration, and tests.
4. Establish what is already implemented, what works, what is incomplete, and what needs to be built.
5. Identify technical debt, security concerns, architectural limitations, and missing requirements.
6. Convert the existing vision into a structured product requirements document, technical specification, and prioritised development backlog.

Preserve the intent of the original project while making evidence-based improvements. Do not assume features work simply because they are described in documentation.

GitHub should remain the authoritative source for application code, project documentation, issues, and change history. Paperclip should coordinate the AI workforce, projects, task allocation, and progress tracking.

## 3. Product Vision and Scope

The objective is to turn Diagram Mapper into a professional, commercially viable application that can be offered to customers through an online subscription service.

The intended product is an interactive infrastructure visualisation and learning platform.

Its central workflow should allow users to:

- Select or connect an Infrastructure as Code (IaC) repository.
- Analyse infrastructure definitions and identify resources and their relationships.
- Generate an accurate, interactive infrastructure diagram.
- Explore individual resources, dependencies, configurations, and relationships.
- Understand what each resource does, why it exists, and how it fits into the wider architecture.
- Access contextual AI explanations grounded in the actual source configuration and relevant documentation.
- Navigate between resources, source references, and related explanations.
- Use a persistent, movable, and resizable chat or explanation panel alongside the diagram.

The interface should make complex infrastructure easier to understand without requiring users to manually interpret large amounts of configuration.

The wider ideas described in `PROMPT.md`, including infrastructure learning, incident investigation, and organisational knowledge, should be evaluated for commercial value and technical feasibility.

Do not assume every proposed feature must be implemented before launch. Prioritise features based on customer value, market research, implementation cost, risk, and the minimum requirements for a successful commercial release.

## 4. Technical Decisions and Tools

No specific programming language, framework, database, cloud provider, hosting platform, payment provider, or AI model has been mandated.

The team should:

- Assess the existing technology stack before proposing changes.
- Retain existing components where they are appropriate and maintainable.
- Compare alternatives when architectural changes are justified.
- Document important technical decisions and their trade-offs.
- Prefer open standards, maintainable architectures, and cost-effective solutions.
- Avoid unnecessary vendor lock-in.
- Design for future extensibility without overengineering the initial release.
- Ensure the application can be developed, tested, deployed, monitored, and maintained reliably.

Do not introduce new frameworks, infrastructure, or paid services without a clear justification.

## 5. AI Team Structure and Responsibilities

I am the product owner and final decision-maker.

The AI team should organise itself around the following responsibilities, assigning specialised agents where appropriate:

- Product management and requirements.
- Market research and competitor analysis.
- UI/UX design and accessibility.
- Frontend development.
- Backend development and architecture.
- AI integration and contextual explanations.
- Automated testing and quality assurance.
- Security and privacy.
- DevOps, deployment, and infrastructure.
- Documentation and developer experience.
- Pricing, positioning, marketing, and commercial launch.

Agents should collaborate, coordinate dependencies, review one another's work, and share relevant findings.

Every task must have a clear owner, expected deliverable, acceptance criteria, and dependencies where applicable.

Require evidence of completion rather than accepting an agent's claim that work is finished.

Work autonomously within the agreed scope. Escalate major architectural changes, significant expenditure, irreversible actions, and decisions that materially alter the product direction.

## 6. Security, Privacy, and Intellectual Property

Security must be considered throughout development rather than added as a final step.

Particular attention must be given to:

- Source repository access and authentication.
- Secure storage and handling of credentials, tokens, and API keys.
- Sensitive infrastructure configurations and customer data.
- Permissions and access controls.
- AI-provider integrations and the data transmitted to external services.
- Logging, data retention, deletion, and backup policies.
- Tenant isolation if multiple customers use the hosted service.
- Dependency vulnerabilities and software supply-chain security.
- Repository licensing, third-party licences, and intellectual property rights.

Never expose credentials, secrets, proprietary configurations, or customer information to AI services or logs without an approved security design.

Evaluate applicable privacy, legal, licensing, and operational requirements before commercial release.

## 7. UI/UX and Product Quality

The application must feel like a cohesive, professional product rather than a technical prototype.

The team should:

- Research comparable products and modern developer-tool interfaces.
- Establish a consistent visual design system.
- Design intuitive navigation and onboarding.
- Make large infrastructure diagrams easy to explore and understand.
- Ensure resource details and AI explanations are accessible without obscuring the diagram.
- Support appropriate responsive layouts and accessibility standards.
- Conduct usability testing with representative users where possible.
- Document significant design decisions and validate them against user needs.

Design decisions should be based on research, usability, and customer value rather than personal preference alone.

## 8. Testing and Verification

Establish an appropriate testing strategy covering:

- Unit testing.
- Integration testing.
- End-to-end testing.
- API and data validation.
- Infrastructure parsing and diagram accuracy.
- AI explanation accuracy and source grounding.
- UI/UX and accessibility.
- Security and permission boundaries.
- Performance and scalability.
- Error handling and recovery.
- Subscription and billing workflows.
- Deployment and production operations.

Automate testing wherever practical.

Verify that infrastructure diagrams accurately represent the source configuration and that explanations do not invent resources, dependencies, or configuration details.

AI-generated explanations must distinguish verified facts from assumptions or uncertainty.

Resolve release-blocking defects before launch. Document residual defects, limitations, and risks explicitly.

## 9. Market
