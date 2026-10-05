// Demo catalog for `npm run db:seed-demo`: AUB-style faculties and courses, and fictional people.
// Every name below is invented; none refers to a real professor or student.

// A faculty with this code is reused when it already exists (from the normal seed or the admin pages);
// otherwise it is created with the demo ID and removed again by --reset.
export const DEMO_FACULTIES = [
  { code: "ENG", id: "demo-faculty-eng", name: "Faculty of Engineering" },
  { code: "FAS", id: "demo-faculty-fas", name: "Faculty of Arts and Sciences" },
  { code: "MED", id: "demo-faculty-med", name: "Faculty of Medicine" },
  { code: "OSB", id: "demo-faculty-osb", name: "Suliman S. Olayan School of Business" },
  { code: "FHS", id: "demo-faculty-fhs", name: "Faculty of Health Sciences" },
  { code: "FAFS", id: "demo-faculty-fafs", name: "Faculty of Agricultural and Food Sciences" },
] as const;

export type FacultyCode = (typeof DEMO_FACULTIES)[number]["code"];
export type DemoCourse = { code: string; name: string; faculty: FacultyCode; topics: string[] };

// Codes are already in the catalog's normalized form (no spaces, upper case). Engineering stays under 20 courses
// in total with the seeded ones, so a faculty filter still fits on one catalog page.
export const DEMO_COURSES: DemoCourse[] = [
  // Faculty of Engineering (15)
  { code: "EECE210", name: "Electric Circuits", faculty: "ENG", topics: ["Kirchhoff's Laws", "Nodal and Mesh Analysis", "Thevenin and Norton Equivalents", "First-Order Circuits", "AC Steady State"] },
  { code: "EECE230", name: "Introduction to Computation and Programming", faculty: "ENG", topics: ["Variables and Control Flow", "Functions", "Arrays and Strings", "Recursion", "Pointers"] },
  { code: "EECE290", name: "Analog Electronics", faculty: "ENG", topics: ["Diodes", "BJT Amplifiers", "MOSFET Biasing", "Operational Amplifiers", "Frequency Response"] },
  { code: "EECE312", name: "Digital Systems Design", faculty: "ENG", topics: ["Boolean Algebra", "Combinational Logic", "Sequential Circuits", "Finite State Machines", "Verilog"] },
  { code: "EECE321", name: "Computer Organization", faculty: "ENG", topics: ["Instruction Set Architecture", "MIPS Assembly", "Datapath and Control", "Pipelining", "Cache Memory"] },
  { code: "EECE340", name: "Signals and Systems", faculty: "ENG", topics: ["LTI Systems", "Convolution", "Fourier Series", "Fourier Transform", "Laplace Transform"] },
  { code: "EECE370", name: "Electromagnetics", faculty: "ENG", topics: ["Vector Calculus", "Electrostatics", "Magnetostatics", "Maxwell's Equations", "Plane Waves"] },
  { code: "EECE380", name: "Communication Systems", faculty: "ENG", topics: ["Amplitude Modulation", "Frequency Modulation", "Sampling", "Noise", "Digital Modulation"] },
  { code: "CIVE210", name: "Statics", faculty: "ENG", topics: ["Force Systems", "Equilibrium", "Trusses", "Friction", "Centroids"] },
  { code: "CIVE310", name: "Structural Analysis", faculty: "ENG", topics: ["Determinate Structures", "Influence Lines", "Deflections", "Force Method", "Slope-Deflection"] },
  { code: "MECH220", name: "Thermodynamics I", faculty: "ENG", topics: ["Properties of Pure Substances", "First Law", "Second Law", "Entropy", "Power Cycles"] },
  { code: "MECH310", name: "Fluid Mechanics", faculty: "ENG", topics: ["Fluid Statics", "Bernoulli Equation", "Control Volume Analysis", "Pipe Flow", "Boundary Layers"] },
  { code: "CHEN311", name: "Chemical Process Principles", faculty: "ENG", topics: ["Material Balances", "Energy Balances", "Reactive Systems", "Phase Equilibrium", "Recycle and Purge"] },
  { code: "INDE301", name: "Operations Research I", faculty: "ENG", topics: ["Linear Programming", "Simplex Method", "Duality", "Transportation Problems", "Network Models"] },
  { code: "ARCH201", name: "Architectural Design Studio I", faculty: "ENG", topics: ["Site Analysis", "Massing Studies", "Spatial Composition", "Precedent Studies", "Design Review"] },
  // Faculty of Arts and Sciences (27)
  { code: "CMPS200", name: "Introduction to Programming", faculty: "FAS", topics: ["Python Basics", "Conditionals and Loops", "Lists and Dictionaries", "Functions", "File Handling"] },
  { code: "CMPS211", name: "Discrete Structures", faculty: "FAS", topics: ["Propositional Logic", "Proof Techniques", "Sets and Functions", "Counting", "Graphs"] },
  { code: "CMPS215", name: "Theory of Computation", faculty: "FAS", topics: ["Finite Automata", "Regular Expressions", "Context-Free Grammars", "Turing Machines", "Decidability"] },
  { code: "CMPS256", name: "Advanced Programming and Data Structures", faculty: "FAS", topics: ["Object-Oriented Design", "Linked Lists", "Stacks and Queues", "Binary Search Trees", "Hash Tables"] },
  { code: "CMPS272", name: "Operating Systems", faculty: "FAS", topics: ["Processes and Threads", "CPU Scheduling", "Synchronization", "Memory Management", "File Systems"] },
  { code: "CMPS277", name: "Database Systems", faculty: "FAS", topics: ["Relational Model", "SQL Queries", "Normalization", "Indexing", "Transactions"] },
  { code: "MATH101", name: "Calculus and Analytic Geometry I", faculty: "FAS", topics: ["Limits", "Derivatives", "Applications of Derivatives", "Integrals", "Fundamental Theorem of Calculus"] },
  { code: "MATH102", name: "Calculus and Analytic Geometry II", faculty: "FAS", topics: ["Integration Techniques", "Improper Integrals", "Sequences", "Series", "Polar Coordinates"] },
  { code: "MATH202", name: "Differential Equations", faculty: "FAS", topics: ["First-Order Equations", "Second-Order Linear Equations", "Laplace Transforms", "Systems of Equations", "Series Solutions"] },
  { code: "MATH211", name: "Discrete Mathematics", faculty: "FAS", topics: ["Logic", "Induction", "Combinatorics", "Recurrence Relations", "Relations"] },
  { code: "MATH218", name: "Elementary Linear Algebra with Applications", faculty: "FAS", topics: ["Systems of Linear Equations", "Matrices", "Determinants", "Vector Spaces", "Eigenvalues"] },
  { code: "STAT201", name: "Introduction to Probability and Statistics", faculty: "FAS", topics: ["Descriptive Statistics", "Probability Rules", "Random Variables", "Sampling Distributions", "Confidence Intervals"] },
  { code: "STAT230", name: "Introduction to Probability and Random Variables", faculty: "FAS", topics: ["Axioms of Probability", "Conditional Probability", "Discrete Distributions", "Continuous Distributions", "Joint Distributions"] },
  { code: "PHYS210", name: "Introductory Physics I", faculty: "FAS", topics: ["Kinematics", "Newton's Laws", "Work and Energy", "Momentum", "Rotational Motion"] },
  { code: "PHYS211", name: "Electricity and Magnetism", faculty: "FAS", topics: ["Electric Fields", "Gauss's Law", "Electric Potential", "Magnetic Fields", "Induction"] },
  { code: "CHEM201", name: "General Chemistry I", faculty: "FAS", topics: ["Atomic Structure", "Chemical Bonding", "Stoichiometry", "Gas Laws", "Thermochemistry"] },
  { code: "CHEM203", name: "Organic Chemistry I", faculty: "FAS", topics: ["Alkanes and Cycloalkanes", "Stereochemistry", "Substitution Reactions", "Elimination Reactions", "Alkenes"] },
  { code: "BIOL201", name: "General Biology I", faculty: "FAS", topics: ["Cell Structure", "Membrane Transport", "Cellular Respiration", "Photosynthesis", "Cell Division"] },
  { code: "BIOL223", name: "Genetics", faculty: "FAS", topics: ["Mendelian Inheritance", "Linkage and Mapping", "DNA Replication", "Gene Expression", "Population Genetics"] },
  { code: "PSYC201", name: "Introduction to Psychology", faculty: "FAS", topics: ["Research Methods", "Sensation and Perception", "Learning", "Memory", "Social Psychology"] },
  { code: "PSYC222", name: "Developmental Psychology", faculty: "FAS", topics: ["Prenatal Development", "Cognitive Development", "Attachment", "Adolescence", "Adulthood and Aging"] },
  { code: "ENGL203", name: "Academic English", faculty: "FAS", topics: ["Paraphrasing and Summarizing", "Argumentative Essays", "Source Integration", "Citation Styles", "Revision Strategies"] },
  { code: "ENGL206", name: "Technical English", faculty: "FAS", topics: ["Technical Descriptions", "Instructions", "Proposals", "Reports", "Presentations"] },
  { code: "ARAB201", name: "Readings in Arabic Literature", faculty: "FAS", topics: ["Classical Poetry", "The Maqama", "Modern Prose", "Literary Criticism", "Contemporary Fiction"] },
  { code: "ECON211", name: "Elementary Microeconomic Theory", faculty: "FAS", topics: ["Supply and Demand", "Elasticity", "Consumer Choice", "Production and Costs", "Market Structures"] },
  { code: "ECON212", name: "Elementary Macroeconomic Theory", faculty: "FAS", topics: ["National Income Accounting", "Aggregate Demand", "Money and Banking", "Inflation", "Fiscal Policy"] },
  { code: "HIST210", name: "History of the Modern Middle East", faculty: "FAS", topics: ["Ottoman Reforms", "The Mandate Period", "Independence Movements", "The Cold War Era", "Contemporary Politics"] },
  // Suliman S. Olayan School of Business (9)
  { code: "ACCT210", name: "Financial Accounting", faculty: "OSB", topics: ["The Accounting Cycle", "Financial Statements", "Inventory", "Receivables", "Long-Term Assets"] },
  { code: "ACCT215", name: "Managerial Accounting", faculty: "OSB", topics: ["Cost Behavior", "Job Order Costing", "Budgeting", "Variance Analysis", "Decision Making"] },
  { code: "BUSS211", name: "Business Statistics", faculty: "OSB", topics: ["Data Visualization", "Probability Distributions", "Hypothesis Testing", "Regression", "Forecasting"] },
  { code: "BUSS230", name: "Business Law", faculty: "OSB", topics: ["Contracts", "Torts", "Agency", "Business Organizations", "Intellectual Property"] },
  { code: "FINA210", name: "Business Finance", faculty: "OSB", topics: ["Time Value of Money", "Bond Valuation", "Stock Valuation", "Capital Budgeting", "Risk and Return"] },
  { code: "FINA310", name: "Investments", faculty: "OSB", topics: ["Portfolio Theory", "CAPM", "Efficient Markets", "Fixed Income", "Derivatives"] },
  { code: "MKTG210", name: "Principles of Marketing", faculty: "OSB", topics: ["Marketing Mix", "Segmentation and Targeting", "Branding", "Pricing Strategies", "Digital Marketing"] },
  { code: "MKTG315", name: "Consumer Behavior", faculty: "OSB", topics: ["Perception", "Motivation", "Attitudes", "Decision Process", "Cultural Influences"] },
  { code: "MNGT215", name: "Fundamentals of Management", faculty: "OSB", topics: ["Planning", "Organizing", "Leadership", "Controlling", "Organizational Culture"] },
  // Faculty of Health Sciences (5)
  { code: "PBHL201", name: "Introduction to Public Health", faculty: "FHS", topics: ["Determinants of Health", "Health Systems", "Global Health", "Health Equity", "Public Health Ethics"] },
  { code: "EPHD300", name: "Principles of Epidemiology", faculty: "FHS", topics: ["Measures of Disease Frequency", "Study Designs", "Bias and Confounding", "Screening", "Outbreak Investigation"] },
  { code: "HPCH210", name: "Health Promotion", faculty: "FHS", topics: ["Behavior Change Theories", "Community Assessment", "Program Planning", "Health Communication", "Evaluation"] },
  { code: "ENHL240", name: "Environmental Health", faculty: "FHS", topics: ["Air Quality", "Water Safety", "Food Safety", "Occupational Health", "Toxicology"] },
  { code: "MLSP220", name: "Clinical Laboratory Methods", faculty: "FHS", topics: ["Specimen Collection", "Hematology", "Clinical Chemistry", "Microbiology", "Quality Control"] },
  // Faculty of Agricultural and Food Sciences (4)
  { code: "NFSC210", name: "Human Nutrition", faculty: "FAFS", topics: ["Macronutrients", "Vitamins", "Minerals", "Energy Balance", "Nutrition Through the Life Cycle"] },
  { code: "NFSC230", name: "Food Chemistry", faculty: "FAFS", topics: ["Water in Foods", "Carbohydrates", "Lipids", "Proteins", "Food Additives"] },
  { code: "AGSC201", name: "Principles of Agriculture", faculty: "FAFS", topics: ["Soil Science", "Crop Production", "Irrigation", "Plant Protection", "Sustainable Farming"] },
  { code: "LDEM210", name: "Landscape Design", faculty: "FAFS", topics: ["Design Principles", "Plant Materials", "Site Planning", "Hardscape", "Planting Plans"] },
  // Faculty of Medicine (3)
  { code: "ANAT301", name: "Human Anatomy", faculty: "MED", topics: ["Upper Limb", "Thorax", "Abdomen", "Head and Neck", "Neuroanatomy"] },
  { code: "PHYL301", name: "Human Physiology", faculty: "MED", topics: ["Cell Physiology", "Cardiovascular System", "Respiratory System", "Renal Physiology", "Endocrine System"] },
  { code: "BIOC301", name: "Medical Biochemistry", faculty: "MED", topics: ["Enzymes", "Carbohydrate Metabolism", "Lipid Metabolism", "Amino Acid Metabolism", "Molecular Biology"] },
];

// Invented first and last names; combinations are generated deterministically.
export const FIRST_NAMES = [
  "Rana", "Karim", "Lina", "Nadim", "Maya", "Samir", "Hiba", "Fadi", "Yasmine", "Tarek", "Zeina", "Walid", "Dana", "Rami", "Nour",
  "Bassel", "Lara", "Ziad", "Mira", "Hadi", "Sara", "Omar", "Layal", "Jad", "Reem", "Elie", "Carla", "Marwan", "Joelle", "Nabil",
  "Rita", "Kamal", "Tala", "Sami", "Leila", "Fouad", "Nadine", "Georges", "Hala", "Imad",
];
export const LAST_NAMES = [
  "Haddad", "Khoury", "Saab", "Nassar", "Aoun", "Fakhoury", "Mansour", "Hamdan", "Rizk", "Daher", "Shami", "Karam", "Najjar", "Sayegh",
  "Mattar", "Harb", "Ghanem", "Salameh", "Tannous", "Azar", "Chidiac", "Bitar", "Hachem", "Zein", "Kassab", "Maalouf", "Abi Nader",
  "Barakat", "Habib", "Jaber", "Khalil", "Moussa", "Nahas", "Rahal", "Sfeir", "Yazbek", "Bou Malham", "Hayek", "Karaki", "Tabbara",
];
