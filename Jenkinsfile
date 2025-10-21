pipeline {
    agent any // Jenkins 에이전트에 Docker가 설치되어 있어야 합니다.

    environment {
        IMAGE_NAME = 'downtime-exporter'
        // 태그에서 'v1.0.' 접두사를 제거하여 빌드와 배포 단계를 통일합니다.
        IMAGE_TAG = "${env.BUILD_NUMBER}"
    }

    stages {
        stage('Build Docker Image') {
            steps {
                script {
                    echo "Building Docker image: ${IMAGE_NAME}:${IMAGE_TAG}"
                    docker.build("${IMAGE_NAME}:${IMAGE_TAG}", '.')
                }
            }
        }

        stage('Deploy (Local)') {
            steps {
                script {
                    echo "Deploying image ${IMAGE_NAME}:${IMAGE_TAG} on the Jenkins agent..."
                    
                    // DB 비밀번호를 위해 Jenkins credentials를 사용합니다.
                    withCredentials([
                        string(credentialsId: 'db-host', variable: 'DB_HOST_SECRET'),
                        string(credentialsId: 'db-user', variable: 'DB_USER_SECRET'),
                        string(credentialsId: 'db-password', variable: 'DB_PASSWORD_SECRET'),
                        string(credentialsId: 'db-database', variable: 'DB_DATABASE_SECRET')
                    ]) {
                        sh '''
                            docker stop ${IMAGE_NAME} || true
                            docker rm ${IMAGE_NAME} || true
                            # 포트 번호를 8002:8002로 수정하고 DB 환경변수를 추가합니다.
                            docker run -d --restart always --name ${IMAGE_NAME} -p 8002:8002 \
                                -e DB_HOST=${DB_HOST_SECRET} \
                                -e DB_USER=${DB_USER_SECRET} \
                                -e DB_PASSWORD=${DB_PASSWORD_SECRET} \
                                -e DB_DATABASE=${DB_DATABASE_SECRET} \
                                ${IMAGE_NAME}:${IMAGE_TAG}
                        '''
                    }
                }
            }
        }
    }

    post {
        always {
            echo 'Pipeline finished.'
        }
    }
}
